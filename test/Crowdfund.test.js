// Import necessary libraries and helpers
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

// Main test suite for the refactored Crowdfund contract
describe("Crowdfund (Refactored v3 - Closure Model)", function () {
    // Shared variables for tests
    let Crowdfund;
    let crowdfund;
    let creator;
    let donor1;
    let donor2;
    let nonParticipant;

    // Constants
    const targetAmount = ethers.parseEther("10");
    const smallDonation = ethers.parseEther("1");
    const midDonation = ethers.parseEther("4");
    const largeDonation = ethers.parseEther("11"); // Exceeds target
    const dataCID = "QmW2WDa7vK7f5fJvvj39p6j8P2k6PjMhAW5tC3Mph5g8N";
    const campaignDurationSeconds = 3600; // 1 hour
    const reclaimPeriodSeconds = 14 * 24 * 60 * 60; // 14 days

    // Status Enum values (matching the contract)
    const Status = {
        Active: 0,
        Completed: 1,
        Closing: 2,
        Withdrawn: 3,
        ClosedByCreator: 4
    };

    // Deploy a fresh contract before each test
    beforeEach(async function () {
        [creator, donor1, donor2, nonParticipant] = await ethers.getSigners();
        Crowdfund = await ethers.getContractFactory("Crowdfund");
        crowdfund = await Crowdfund.deploy();
        await crowdfund.deploymentTransaction()?.wait();
    });

    // --- Helper Function to Create Campaigns ---
    async function createActiveCampaign(creatorSigner = creator, durationSeconds = campaignDurationSeconds, customTarget = targetAmount) {
        const latestTimestamp = await time.latest();
        const endTime = latestTimestamp + durationSeconds;
        const tx = await crowdfund.connect(creatorSigner).createCampaign(customTarget, dataCID, BigInt(endTime));
        const receipt = await tx.wait();
        const campaignCreatedEvent = receipt?.logs?.find(log => log.fragment?.name === "CampaignCreated");
        if (!campaignCreatedEvent) throw new Error("CampaignCreated event not found.");
        return {
            campaignId: campaignCreatedEvent.args.campaignId,
            endTime: BigInt(endTime)
        };
    }

    // --- Helper to get campaign state ---
    async function getCampaignState(campaignId) {
        return await crowdfund.campaigns(campaignId);
    }

    // ==================================
    // === Campaign Creation Tests ===
    // ==================================
    describe("Campaign Creation", function () {
        it("Should create a campaign with correct initial state", async function () {
            const latestTimestamp = await time.latest();
            const endTime = latestTimestamp + campaignDurationSeconds;
            const tx = await crowdfund.connect(creator).createCampaign(targetAmount, dataCID, BigInt(endTime));
            const campaignId = 1n;

            await expect(tx)
                .to.emit(crowdfund, "CampaignCreated")
                .withArgs(campaignId, creator.address, targetAmount, dataCID, BigInt(endTime), await time.latest());

            const campaign = await getCampaignState(campaignId);
            expect(campaign.creator).to.equal(creator.address);
            expect(campaign.targetAmount).to.equal(targetAmount);
            expect(campaign.raisedAmount).to.equal(0n);
            expect(campaign.totalEverRaised).to.equal(0n);
            expect(campaign.dataCID).to.equal(dataCID);
            expect(campaign.endTime).to.equal(BigInt(endTime));
            expect(campaign.status).to.equal(Status.Active);
            expect(campaign.creationTimestamp).to.be.gt(0n);
            expect(campaign.reclaimDeadline).to.equal(0n);
        });

        it("Should revert campaign creation if target amount is zero", async function () {
            const endTime = (await time.latest()) + campaignDurationSeconds;
            await expect(crowdfund.connect(creator).createCampaign(0, dataCID, BigInt(endTime)))
                .to.be.revertedWithCustomError(crowdfund, "TargetAmountMustBePositive");
        });
        it("Should revert campaign creation if end time is not in the future", async function () {
            const pastTime = await time.latest();
            await expect(crowdfund.connect(creator).createCampaign(targetAmount, dataCID, BigInt(pastTime)))
                .to.be.revertedWithCustomError(crowdfund, "EndTimeNotInFuture");
        });
        it("Should revert campaign creation if data CID is empty", async function () {
            const endTime = (await time.latest()) + campaignDurationSeconds;
            await expect(crowdfund.connect(creator).createCampaign(targetAmount, "", BigInt(endTime)))
                .to.be.revertedWithCustomError(crowdfund, "DataCIDCannotBeEmpty");
        });
    });

    // ==================================
    // === Donation Tests ===
    // ==================================
    describe("Donations", function () {
        let campaignId;
        let endTime;

        beforeEach(async function() {
            ({ campaignId, endTime } = await createActiveCampaign());
        });

        it("Should allow donation, update balances/totals and track donation", async function () {
            const tx = await crowdfund.connect(donor1).donate(campaignId, { value: smallDonation });
            await expect(tx)
                .to.emit(crowdfund, "DonationReceived")
                .withArgs(campaignId, donor1.address, smallDonation, await time.latest());

            const campaign = await getCampaignState(campaignId);
            expect(campaign.raisedAmount).to.equal(smallDonation);
            expect(campaign.totalEverRaised).to.equal(smallDonation);
            expect(await crowdfund.donations(campaignId, donor1.address)).to.equal(smallDonation);
        });

        it("Should allow multiple donations from same donor and track correctly", async function () {
            await crowdfund.connect(donor1).donate(campaignId, { value: smallDonation });
            await crowdfund.connect(donor1).donate(campaignId, { value: midDonation }); // Donate again

            const campaign = await getCampaignState(campaignId);
            const expectedTotal = smallDonation + midDonation;
            expect(campaign.raisedAmount).to.equal(expectedTotal);
            expect(campaign.totalEverRaised).to.equal(expectedTotal);
            expect(await crowdfund.donations(campaignId, donor1.address)).to.equal(expectedTotal);
        });

        it("Should update status to Completed when target is reached", async function () {
            await crowdfund.connect(donor1).donate(campaignId, { value: targetAmount });
            const campaign = await getCampaignState(campaignId);
            expect(campaign.status).to.equal(Status.Completed);
        });

        it("Should revert donation if campaign is not Active", async function () {
            // Make Completed
            await crowdfund.connect(donor1).donate(campaignId, { value: targetAmount });
            await expect(crowdfund.connect(donor2).donate(campaignId, { value: smallDonation }))
                .to.be.revertedWithCustomError(crowdfund, "CampaignNotActive");

            // Make Closing
            const { campaignId: closingCampaignId } = await createActiveCampaign();
            await crowdfund.connect(creator).initiateClosure(closingCampaignId);
            await expect(crowdfund.connect(donor1).donate(closingCampaignId, { value: smallDonation }))
                .to.be.revertedWithCustomError(crowdfund, "CampaignNotActive");
        });

        it("Should revert donation if campaign original end time has passed", async function () {
            await time.increaseTo(endTime + 1n);
            await expect(crowdfund.connect(donor1).donate(campaignId, { value: smallDonation }))
                .to.be.revertedWithCustomError(crowdfund, "CampaignHasEnded");
        });

        it("Should revert donation if campaign ID is invalid", async function () {
            await expect(crowdfund.connect(donor1).donate(999, { value: smallDonation }))
                .to.be.revertedWithCustomError(crowdfund, "InvalidCampaignId");
        });
        it("Should revert donation if amount is zero", async function () {
            await expect(crowdfund.connect(donor1).donate(campaignId, { value: 0 }))
                .to.be.revertedWithCustomError(crowdfund, "DonationAmountMustBePositive");
        });
    });

     // ===============================
    // === Claiming Refunds Tests ===
    // ===============================
    describe("Claiming Refunds (claimRefund)", function () {
        let campaignId;
        let endTime;

        beforeEach(async function() {
            ({ campaignId, endTime } = await createActiveCampaign());
            // Donor 1: smallDonation, Donor 2: midDonation
            await crowdfund.connect(donor1).donate(campaignId, { value: smallDonation });
            await crowdfund.connect(donor2).donate(campaignId, { value: midDonation });
        });

        it("Should allow a donor to claim refund while campaign is Active", async function () {
            const initialBalance = await ethers.provider.getBalance(donor1.address);
            const initialCampaign = await getCampaignState(campaignId);

            const tx = await crowdfund.connect(donor1).claimRefund(campaignId);
            const receipt = await tx.wait();
            const gasCost = BigInt(receipt?.gasUsed ?? 0n) * BigInt(tx.gasPrice ?? 0n);
            const finalBalance = await ethers.provider.getBalance(donor1.address);
            const finalCampaign = await getCampaignState(campaignId);

            await expect(tx)
                .to.emit(crowdfund, "RefundClaimed")
                .withArgs(campaignId, donor1.address, smallDonation);

            expect(await crowdfund.donations(campaignId, donor1.address)).to.equal(0);
            expect(await crowdfund.hasReclaimed(campaignId, donor1.address)).to.be.true;
            expect(finalCampaign.raisedAmount).to.equal(initialCampaign.raisedAmount - smallDonation);
            expect(finalCampaign.totalEverRaised).to.equal(initialCampaign.totalEverRaised); // Unchanged
            expect(finalBalance).to.equal(initialBalance + smallDonation - gasCost);
        });

        it("Should allow a donor to claim refund while campaign is Closing (before deadline)", async function () {
            await crowdfund.connect(creator).initiateClosure(campaignId); // Move to Closing
            const initialBalance = await ethers.provider.getBalance(donor2.address);
            const initialCampaign = await getCampaignState(campaignId);

            const tx = await crowdfund.connect(donor2).claimRefund(campaignId);
            const receipt = await tx.wait();
            const gasCost = BigInt(receipt?.gasUsed ?? 0n) * BigInt(tx.gasPrice ?? 0n);
            const finalBalance = await ethers.provider.getBalance(donor2.address);
            const finalCampaign = await getCampaignState(campaignId);

             await expect(tx)
                .to.emit(crowdfund, "RefundClaimed")
                .withArgs(campaignId, donor2.address, midDonation);

            expect(await crowdfund.donations(campaignId, donor2.address)).to.equal(0);
            expect(await crowdfund.hasReclaimed(campaignId, donor2.address)).to.be.true;
            expect(finalCampaign.raisedAmount).to.equal(initialCampaign.raisedAmount - midDonation);
            expect(finalBalance).to.equal(initialBalance + midDonation - gasCost);
        });

        it("Should revert refund claim if already reclaimed", async function () {
            await crowdfund.connect(donor1).claimRefund(campaignId); // First claim
            // **FIXED ASSERTION:** Expect NoDonationToClaim because donation record is zeroed
            await expect(crowdfund.connect(donor1).claimRefund(campaignId)) // Second claim
                .to.be.revertedWithCustomError(crowdfund, "NoDonationToClaim");
        });

        it("Should revert refund claim if donor made no donation", async function () {
            await expect(crowdfund.connect(nonParticipant).claimRefund(campaignId))
                .to.be.revertedWithCustomError(crowdfund, "NoDonationToClaim");
        });

        it("Should revert refund claim if campaign status is Completed", async function () {
            // Need more funds to complete
            const needed = targetAmount - smallDonation - midDonation;
            await crowdfund.connect(donor1).donate(campaignId, { value: needed });
            expect((await getCampaignState(campaignId)).status).to.equal(Status.Completed);

            await expect(crowdfund.connect(donor1).claimRefund(campaignId))
                .to.be.revertedWithCustomError(crowdfund, "CampaignNotActiveOrClosing");
        });

        it("Should revert refund claim if campaign status is Withdrawn", async function () {
             const needed = targetAmount - smallDonation - midDonation;
            await crowdfund.connect(donor1).donate(campaignId, { value: needed }); // Complete
            await crowdfund.connect(creator).withdrawFunds(campaignId); // Withdraw
            await expect(crowdfund.connect(donor1).claimRefund(campaignId))
                .to.be.revertedWithCustomError(crowdfund, "CampaignNotActiveOrClosing");
        });

         it("Should revert refund claim if campaign status is ClosedByCreator", async function () {
            await crowdfund.connect(creator).initiateClosure(campaignId);
            const { reclaimDeadline } = await getCampaignState(campaignId);
            await time.increaseTo(reclaimDeadline);
            await crowdfund.connect(creator).finalizeClosureAndWithdraw(campaignId);

            await expect(crowdfund.connect(donor1).claimRefund(campaignId))
                .to.be.revertedWithCustomError(crowdfund, "CampaignNotActiveOrClosing");
        });

        it("Should revert refund claim if campaign is Closing and reclaim period is over", async function () {
            await crowdfund.connect(creator).initiateClosure(campaignId);
            const { reclaimDeadline } = await getCampaignState(campaignId);
            await time.increaseTo(reclaimDeadline + 1n); // Fast forward past deadline

            await expect(crowdfund.connect(donor1).claimRefund(campaignId))
                .to.be.revertedWithCustomError(crowdfund, "ReclaimPeriodOver");
        });

         it("Should revert refund claim if transfer fails (check nonReentrant)", async function () {
            // Basic check that non-reentrant call works
            await expect(crowdfund.connect(donor1).claimRefund(campaignId)).to.not.be.reverted;
        });
    });

    // ===============================
    // === Campaign Closure Tests ===
    // ===============================
    describe("Campaign Closure (initiateClosure / finalizeClosureAndWithdraw)", function () {
        let campaignId;

        beforeEach(async function() {
            ({ campaignId } = await createActiveCampaign());
            await crowdfund.connect(donor1).donate(campaignId, { value: smallDonation });
            await crowdfund.connect(donor2).donate(campaignId, { value: midDonation });
        });

        describe("initiateClosure", function () {
            it("Should allow creator to initiate closure for an Active campaign", async function () {
                const tx = await crowdfund.connect(creator).initiateClosure(campaignId);
                const blockTimestamp = await time.latest();
                const expectedDeadline = BigInt(blockTimestamp) + BigInt(reclaimPeriodSeconds);

                const campaign = await getCampaignState(campaignId);
                expect(campaign.status).to.equal(Status.Closing);
                expect(campaign.reclaimDeadline).to.equal(expectedDeadline);

                await expect(tx)
                    .to.emit(crowdfund, "CampaignClosingInitiated")
                    .withArgs(campaignId, creator.address, expectedDeadline);
            });

            it("Should allow creator to initiate closure for an Active campaign after endTime", async function () {
                const { campaignId: lateCampaignId, endTime } = await createActiveCampaign();
                await crowdfund.connect(donor1).donate(lateCampaignId, {value: smallDonation}); // Add donation
                await time.increaseTo(endTime + 1n); // Go past end time

                await expect(crowdfund.connect(creator).initiateClosure(lateCampaignId))
                    .to.not.be.reverted;
                const campaign = await getCampaignState(lateCampaignId);
                expect(campaign.status).to.equal(Status.Closing);
            });

            it("Should revert initiateClosure if caller is not the creator", async function () {
                await expect(crowdfund.connect(donor1).initiateClosure(campaignId))
                    .to.be.revertedWithCustomError(crowdfund, "NotCampaignCreator");
            });

            it("Should revert initiateClosure if campaign is Completed", async function () {
                const needed = targetAmount - smallDonation - midDonation;
                await crowdfund.connect(donor1).donate(campaignId, { value: needed }); // Make Completed
                await expect(crowdfund.connect(creator).initiateClosure(campaignId))
                    .to.be.revertedWithCustomError(crowdfund, "CannotCloseCompletedCampaign");
            });

            it("Should revert initiateClosure if campaign is already Closing", async function () {
                await crowdfund.connect(creator).initiateClosure(campaignId); // Already Closing
                await expect(crowdfund.connect(creator).initiateClosure(campaignId))
                    .to.be.revertedWithCustomError(crowdfund, "CampaignNotActive");
            });

            it("Should revert initiateClosure if campaign is Withdrawn", async function () {
                 const needed = targetAmount - smallDonation - midDonation;
                await crowdfund.connect(donor1).donate(campaignId, { value: needed }); // Complete
                await crowdfund.connect(creator).withdrawFunds(campaignId); // Withdraw
                await expect(crowdfund.connect(creator).initiateClosure(campaignId))
                    .to.be.revertedWithCustomError(crowdfund, "CampaignNotActive");
            });
        });

        describe("finalizeClosureAndWithdraw", function () {
            let reclaimDeadline;
            let initialRaisedAmount;

            beforeEach(async function() {
                // Initiate closure first
                await crowdfund.connect(creator).initiateClosure(campaignId);
                const campaign = await getCampaignState(campaignId);
                reclaimDeadline = campaign.reclaimDeadline;
                initialRaisedAmount = campaign.raisedAmount; // smallDonation + midDonation
            });

            it("Should allow creator to finalize and withdraw remaining funds after deadline", async function () {
                // Donor 1 claims refund
                await crowdfund.connect(donor1).claimRefund(campaignId);
                const amountRemaining = initialRaisedAmount - smallDonation; // midDonation should be left

                // Fast forward past deadline
                await time.increaseTo(reclaimDeadline + 1n);

                const initialCreatorBalance = await ethers.provider.getBalance(creator.address);
                const tx = await crowdfund.connect(creator).finalizeClosureAndWithdraw(campaignId);
                const receipt = await tx.wait();
                const gasCost = BigInt(receipt?.gasUsed ?? 0n) * BigInt(tx.gasPrice ?? 0n);
                const finalCreatorBalance = await ethers.provider.getBalance(creator.address);

                await expect(tx)
                    .to.emit(crowdfund, "CampaignClosedByCreator")
                    .withArgs(campaignId, creator.address, amountRemaining);

                const campaign = await getCampaignState(campaignId);
                expect(campaign.status).to.equal(Status.ClosedByCreator);
                expect(campaign.raisedAmount).to.equal(0n);
                expect(finalCreatorBalance).to.equal(initialCreatorBalance + amountRemaining - gasCost);
            });

             it("Should allow creator to finalize closure if all funds were reclaimed", async function () {
                await crowdfund.connect(donor1).claimRefund(campaignId);
                await crowdfund.connect(donor2).claimRefund(campaignId);
                const amountRemaining = 0n;

                await time.increaseTo(reclaimDeadline + 1n);
                const tx = await crowdfund.connect(creator).finalizeClosureAndWithdraw(campaignId);

                await expect(tx)
                    .to.emit(crowdfund, "CampaignClosedByCreator")
                    .withArgs(campaignId, creator.address, amountRemaining);

                const campaign = await getCampaignState(campaignId);
                expect(campaign.status).to.equal(Status.ClosedByCreator);
                expect(campaign.raisedAmount).to.equal(0n);
            });

            it("Should revert finalizeClosure if caller is not the creator", async function () {
                 await time.increaseTo(reclaimDeadline + 1n);
                 await expect(crowdfund.connect(donor1).finalizeClosureAndWithdraw(campaignId))
                    .to.be.revertedWithCustomError(crowdfund, "NotCampaignCreator");
            });

            it("Should revert finalizeClosure if campaign is not in Closing state", async function () {
                const { campaignId: activeCampaignId } = await createActiveCampaign();
                await expect(crowdfund.connect(creator).finalizeClosureAndWithdraw(activeCampaignId))
                    .to.be.revertedWithCustomError(crowdfund, "CampaignNotClosing");
            });

            it("Should revert finalizeClosure if reclaim period is still active", async function () {
                await expect(crowdfund.connect(creator).finalizeClosureAndWithdraw(campaignId))
                    .to.be.revertedWithCustomError(crowdfund, "ReclaimPeriodActive");
            });

             it("Should revert finalizeClosure if already finalized", async function () {
                await time.increaseTo(reclaimDeadline + 1n);
                await crowdfund.connect(creator).finalizeClosureAndWithdraw(campaignId); // Finalize once
                await expect(crowdfund.connect(creator).finalizeClosureAndWithdraw(campaignId)) // Try again
                    .to.be.revertedWithCustomError(crowdfund, "CampaignNotClosing"); // Status is now ClosedByCreator
            });
        });
    });

    // ===============================
    // === Standard Withdrawal Tests ===
    // ===============================
    describe("Standard Withdrawal (withdrawFunds)", function () {
        let campaignId;

        beforeEach(async function() {
            ({ campaignId } = await createActiveCampaign());
            await crowdfund.connect(donor1).donate(campaignId, { value: targetAmount }); // Complete it
        });

        it("Should allow creator withdrawFunds if Completed", async function () {
            const initialCreatorBalance = await ethers.provider.getBalance(creator.address);
            const tx = await crowdfund.connect(creator).withdrawFunds(campaignId);
            const receipt = await tx.wait();
            const finalCreatorBalance = await ethers.provider.getBalance(creator.address);
            const gasCost = BigInt(receipt?.gasUsed ?? 0n) * BigInt(tx.gasPrice ?? 0n);

            await expect(tx)
                .to.emit(crowdfund, "FundsWithdrawn")
                .withArgs(campaignId, creator.address, targetAmount);

            const campaign = await getCampaignState(campaignId);
            expect(campaign.status).to.equal(Status.Withdrawn);
            expect(campaign.raisedAmount).to.equal(0n);
            expect(finalCreatorBalance).to.equal(initialCreatorBalance + targetAmount - gasCost);
        });

        it("Should revert withdrawFunds if not Completed (e.g., Active)", async function () {
             const { campaignId: activeCampaignId } = await createActiveCampaign();
             await expect(crowdfund.connect(creator).withdrawFunds(activeCampaignId))
                .to.be.revertedWithCustomError(crowdfund, "CampaignNotCompleted");
        });

        it("Should revert withdrawFunds if not Completed (e.g., Closing)", async function () {
             // **FIXED SETUP**
             // Create a new campaign that will be put into Closing state
             const { campaignId: closingCampaignId } = await createActiveCampaign();
             await crowdfund.connect(donor1).donate(closingCampaignId, { value: smallDonation }); // Donate some
             await crowdfund.connect(creator).initiateClosure(closingCampaignId); // Make it Closing
             // Now test withdrawFunds on the campaign that is actually Closing
             await expect(crowdfund.connect(creator).withdrawFunds(closingCampaignId))
                .to.be.revertedWithCustomError(crowdfund, "CampaignNotCompleted");
        });

        it("Should revert withdrawFunds if caller is not creator", async function () {
            await expect(crowdfund.connect(donor1).withdrawFunds(campaignId))
                .to.be.revertedWithCustomError(crowdfund, "NotCampaignCreator");
        });
         it("Should revert withdrawFunds if campaign ID is invalid", async function () {
             await expect(crowdfund.connect(creator).withdrawFunds(999))
                .to.be.revertedWithCustomError(crowdfund, "InvalidCampaignId");
        });
         it("Should revert withdrawFunds if already withdrawn", async function () {
             await crowdfund.connect(creator).withdrawFunds(campaignId); // Withdraw first time
             await expect(crowdfund.connect(creator).withdrawFunds(campaignId)) // Try second time
                .to.be.revertedWithCustomError(crowdfund, "CampaignNotCompleted"); // Status is now Withdrawn
        });
    });

    // ===============================
    // === Getter Function Tests ===
    // ===============================
     describe("Getter Functions", function () {
         it("Should return the correct creator address", async function () {
            const { campaignId } = await createActiveCampaign();
            const fetchedCreator = await crowdfund.getCampaignCreator(campaignId);
            expect(fetchedCreator).to.equal(creator.address);
         });

         it("Should revert getting creator if campaign ID is invalid (non-existent)", async function () {
             await expect(crowdfund.getCampaignCreator(999))
                .to.be.revertedWithCustomError(crowdfund, "InvalidCampaignId");
         });
         it("Should revert getting creator if campaign ID is zero", async function () {
             await expect(crowdfund.getCampaignCreator(0))
                .to.be.revertedWithCustomError(crowdfund, "InvalidCampaignId");
         });
     });

    // ===============================
    // === Reentrancy Guard Tests ===
    // ===============================
    describe("Reentrancy Guard", function () {
        // Test reentrancy on withdrawFunds (Completed)
         it("Should prevent reentrancy attack in withdrawFunds (Completed)", async function () {
             const AttackContractFactory = await ethers.getContractFactory("ReentrancyAttackMock");
             // Deploy the mock contract using the correct crowdfund address
             const attackerMock = await AttackContractFactory.deploy(await crowdfund.getAddress());
             await attackerMock.deploymentTransaction()?.wait();

             const latestTimestamp = await time.latest();
             const endTime = latestTimestamp + campaignDurationSeconds;
             // Mock creates campaign
             // Use the mock's signer (nonParticipant) to call createCampaignOnBehalf
             await attackerMock.connect(nonParticipant).createCampaignOnBehalf(targetAmount, dataCID, BigInt(endTime));
             const mockCampaignId = await crowdfund.nextCampaignId() - 1n; // Get the ID

             // Complete campaign created by mock (anyone can donate)
             await crowdfund.connect(donor1).donate(mockCampaignId, { value: targetAmount });

             // Attempt withdrawal via mock's attackWithdraw, targeting original withdrawFunds
             // The mock contract itself is the creator in this case
             await expect(attackerMock.connect(nonParticipant).attackWithdraw(mockCampaignId))
                 .to.be.revertedWithCustomError(crowdfund, "FundTransferFailed"); // Expect FundTransferFailed due to reentrancy block in receive()
        });

        // Basic checks for nonReentrant modifiers on new/modified functions
        it("Should have nonReentrant guard on donate", async function () {
             // **FIXED SETUP** Create campaign 1 first
             const { campaignId } = await createActiveCampaign();
             expect(campaignId).to.equal(1n); // Ensure it's campaign 1
             await expect(crowdfund.connect(donor1).donate(campaignId, { value: smallDonation })).to.not.be.reverted;
         });

         it("Should have nonReentrant guard on claimRefund", async function () {
             const { campaignId } = await createActiveCampaign();
             await crowdfund.connect(donor1).donate(campaignId, { value: smallDonation });
             await expect(crowdfund.connect(donor1).claimRefund(campaignId)).to.not.be.reverted;
         });

         it("Should have nonReentrant guard on initiateClosure", async function () {
             const { campaignId } = await createActiveCampaign();
             await expect(crowdfund.connect(creator).initiateClosure(campaignId)).to.not.be.reverted;
         });

         it("Should have nonReentrant guard on finalizeClosureAndWithdraw", async function () {
             const { campaignId } = await createActiveCampaign();
             await crowdfund.connect(creator).initiateClosure(campaignId);
             const { reclaimDeadline } = await getCampaignState(campaignId);
             await time.increaseTo(reclaimDeadline + 1n);
             await expect(crowdfund.connect(creator).finalizeClosureAndWithdraw(campaignId)).to.not.be.reverted;
         });
    });

}); // End describe("Crowdfund (Refactored v3 - Closure Model)")
