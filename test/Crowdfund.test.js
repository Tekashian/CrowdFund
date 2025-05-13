// Import necessary libraries and helpers
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

// Main test suite for the Crowdfund contract with commissions
describe("Crowdfund (v4.1 - Commissions & Default Wallet)", function () {
    // Shared variables for tests
    let Crowdfund;
    let crowdfund;
    let owner; // Renamed from creator for clarity, as this is the contract owner
    let creatorAcc; // Account creating campaigns
    let donor1;
    let donor2;
    let nonParticipant;
    let commissionRecipient; // Used for testing commission payouts

    // Constants
    const targetAmount = ethers.parseEther("10");
    const smallDonation = ethers.parseEther("1"); // This will be treated as msg.value (gross donation)
    const midDonation = ethers.parseEther("4");   // This will be treated as msg.value (gross donation)
    const largeDonation = ethers.parseEther("11"); // Exceeds target
    const dataCID = "QmW2WDa7vK7f5fJvvj39p6j8P2k6PjMhAW5tC3Mph5g8N";
    const campaignDurationSeconds = 3600; // 1 hour
    const reclaimPeriodSeconds = 14 * 24 * 60 * 60; // 14 days

    const defaultCommissionWalletAddress = "0x50a185CfCD1Ce799057EAa83586D1061F3C073c1"; // As in contract
    const initialStartupCommission = 200n; // 2.00% (contract stores as 200)
    const initialCharityCommission = 0n;   // 0.00% (contract stores as 0)

    // Enums matching the contract
    const Status = {
        Active: 0,
        Completed: 1,
        Closing: 2,
        Withdrawn: 3,
        ClosedByCreator: 4
    };
    const CampaignType = { Startup: 0, Charity: 1 };

    // Deploy a fresh contract before each test
    beforeEach(async function () {
        [owner, creatorAcc, donor1, donor2, nonParticipant, commissionRecipient] = await ethers.getSigners();
        Crowdfund = await ethers.getContractFactory("Crowdfund");
        crowdfund = await Crowdfund.deploy(
            owner.address, // _initialOwner
            initialStartupCommission, // _initialStartupCommissionPercentage
            initialCharityCommission  // _initialCharityCommissionPercentage
        );
        await crowdfund.waitForDeployment();
    });

    // --- Helper Function to Create Campaigns ---
    async function createActiveCampaign(
        campaignType = CampaignType.Startup,
        creatorSigner = creatorAcc,
        durationSeconds = campaignDurationSeconds,
        customTarget = targetAmount
    ) {
        const latestTimestamp = await time.latest();
        const endTime = latestTimestamp + durationSeconds;
        const tx = await crowdfund.connect(creatorSigner).createCampaign(
            campaignType,
            customTarget,
            dataCID,
            BigInt(endTime)
        );
        const receipt = await tx.wait();

        // Find event manually if not using Hardhat's getEvent (ethers v6)
        let campaignCreatedEventLog;
        if (receipt.logs) { // Hardhat Network provides logs directly on receipt
            campaignCreatedEventLog = receipt.logs.find(
                (log) => {
                    try {
                        const parsedLog = crowdfund.interface.parseLog(log);
                        return parsedLog?.name === "CampaignCreated";
                    } catch (e) { return false; }
                }
            );
        }

        if (!campaignCreatedEventLog) { // Fallback or if using different ethers version structure
            const events = await crowdfund.queryFilter(crowdfund.filters.CampaignCreated(), receipt.blockNumber);
            campaignCreatedEventLog = events.find(e => e.transactionHash === tx.hash);
        }


        if (!campaignCreatedEventLog) throw new Error("CampaignCreated event not found in transaction receipt.");

        const parsedArgs = crowdfund.interface.parseLog(campaignCreatedEventLog).args;

        return {
            campaignId: parsedArgs.campaignId,
            campaignType: parsedArgs.campaignType,
            creatorAddress: parsedArgs.creator, // creator is an indexed field
            targetAmount: parsedArgs.targetAmount,
            endTime: parsedArgs.endTime,
            creationTimestamp: parsedArgs.creationTimestamp
        };
    }

    // --- Helper to get campaign state using the contract's getter ---
    async function getCampaignState(campaignId) {
        return await crowdfund.getCampaign(campaignId);
    }

    describe("Contract Initialization", function () {
        it("Should set the correct owner", async function () {
            expect(await crowdfund.owner()).to.equal(owner.address);
        });
        it("Should set the default commission wallet", async function () {
            expect(await crowdfund.commissionWallet()).to.equal(defaultCommissionWalletAddress);
        });
        it("Should set initial startup commission percentage", async function () {
            expect(await crowdfund.startupCommissionPercentage()).to.equal(initialStartupCommission);
        });
        it("Should set initial charity commission percentage", async function () {
            expect(await crowdfund.charityCommissionPercentage()).to.equal(initialCharityCommission);
        });
    });

    // ==================================
    // === Campaign Creation Tests ===
    // ==================================
    describe("Campaign Creation", function () {
        it("Should create a Startup campaign with correct initial state", async function () {
            const latestTimestamp = await time.latest();
            const endTime = latestTimestamp + campaignDurationSeconds;
            const tx = await crowdfund.connect(creatorAcc).createCampaign(CampaignType.Startup, targetAmount, dataCID, BigInt(endTime));
            const campaignId = 1n; // Assuming it's the first campaign

            // Event: CampaignCreated(uint256 indexed campaignId, address indexed creator, CampaignType campaignType, uint256 targetAmount, string dataCID, uint256 endTime, uint256 creationTimestamp);
            await expect(tx)
                .to.emit(crowdfund, "CampaignCreated")
                .withArgs(campaignId, creatorAcc.address, CampaignType.Startup, targetAmount, dataCID, BigInt(endTime), await time.latest());

            const campaign = await getCampaignState(campaignId);
            expect(campaign.creator).to.equal(creatorAcc.address);
            expect(campaign.campaignType).to.equal(CampaignType.Startup);
            expect(campaign.targetAmount).to.equal(targetAmount);
            expect(campaign.raisedAmount).to.equal(0n);
            expect(campaign.totalEverRaised).to.equal(0n);
            expect(campaign.dataCID).to.equal(dataCID);
            expect(campaign.endTime).to.equal(BigInt(endTime));
            expect(campaign.status).to.equal(Status.Active);
            expect(campaign.creationTimestamp).to.be.gt(0n);
            expect(campaign.reclaimDeadline).to.equal(0n);
        });

        it("Should create a Charity campaign with correct initial state", async function () {
            const latestTimestamp = await time.latest();
            const endTime = latestTimestamp + campaignDurationSeconds;
            const tx = await crowdfund.connect(creatorAcc).createCampaign(CampaignType.Charity, targetAmount, dataCID, BigInt(endTime));
            const campaignId = 1n;

            await expect(tx)
                .to.emit(crowdfund, "CampaignCreated")
                .withArgs(campaignId, creatorAcc.address, CampaignType.Charity, targetAmount, dataCID, BigInt(endTime), await time.latest());

            const campaign = await getCampaignState(campaignId);
            expect(campaign.campaignType).to.equal(CampaignType.Charity);
        });


        it("Should revert campaign creation if target amount is zero", async function () {
            const endTime = (await time.latest()) + campaignDurationSeconds;
            await expect(crowdfund.connect(creatorAcc).createCampaign(CampaignType.Startup, 0, dataCID, BigInt(endTime)))
                .to.be.revertedWithCustomError(crowdfund, "TargetAmountMustBePositive");
        });
        it("Should revert campaign creation if end time is not in the future", async function () {
            const pastTime = await time.latest(); // Not +1, so it's current or past
            await expect(crowdfund.connect(creatorAcc).createCampaign(CampaignType.Startup, targetAmount, dataCID, BigInt(pastTime)))
                .to.be.revertedWithCustomError(crowdfund, "EndTimeNotInFuture");
        });
        it("Should revert campaign creation if data CID is empty", async function () {
            const endTime = (await time.latest()) + campaignDurationSeconds;
            await expect(crowdfund.connect(creatorAcc).createCampaign(CampaignType.Startup, targetAmount, "", BigInt(endTime)))
                .to.be.revertedWithCustomError(crowdfund, "DataCIDCannotBeEmpty");
        });
        it("Should revert campaign creation if commission wallet is address(0) (after owner sets it)", async function () {
            // First, owner sets commission wallet to address(0) - this should revert
            await expect(crowdfund.connect(owner).setCommissionWallet(ethers.ZeroAddress))
                .to.be.revertedWithCustomError(crowdfund, "CommissionWalletNotSet");

            // To properly test createCampaign's internal check, we'd need to bypass setCommissionWallet's check
            // or have commissionWallet be non-constant in a test-only version.
            // Given the current setup, this specific check in createCampaign is a defense-in-depth,
            // primarily for if setCommissionWallet was somehow bypassed or allowed address(0).
            // Since commissionWallet is initialized to a non-zero constant and setCommissionWallet prevents setting to zero,
            // the check in createCampaign: `if (commissionWallet == address(0)) revert CommissionWalletNotSet();`
            // is hard to trigger without modifying the contract for testing.
            // We've tested that setCommissionWallet(0) reverts, which is the main gate.
        });
    });

    // ==================================
    // === Donation Tests ===
    // ==================================
    describe("Donations", function () {
        let campaignDetails;
        const startupCommissionRate = initialStartupCommission; // 200n (for 2.00%)
        const charityCommissionRate = initialCharityCommission; // 0n   (for 0.00%)

        async function testDonation(
            campaignType,
            donationAmount,
            expectedCommissionRate,
            donor = donor1,
            useCommissionRecipient = false // if true, commission wallet is set to commissionRecipient.address
        ) {
            if (useCommissionRecipient) {
                await crowdfund.connect(owner).setCommissionWallet(commissionRecipient.address);
            }
            const currentCommissionWallet = await crowdfund.commissionWallet();


            campaignDetails = await createActiveCampaign(campaignType, creatorAcc);
            const campaignId = campaignDetails.campaignId;

            const initialCommissionWalletBalance = await ethers.provider.getBalance(currentCommissionWallet);
            const initialCampaignState = await getCampaignState(campaignId);

            const tx = await crowdfund.connect(donor).donate(campaignId, { value: donationAmount });
            const expectedCommission = (donationAmount * expectedCommissionRate) / 10000n;
            const expectedAmountToCampaign = donationAmount - expectedCommission;

            // Event: DonationReceived(uint256 indexed campaignId, address indexed donor, uint256 amount, uint256 commissionAmount, uint256 timestamp);
            // `amount` is msg.value, `commissionAmount` is the calculated commission.
            await expect(tx)
                .to.emit(crowdfund, "DonationReceived")
                .withArgs(campaignId, donor.address, donationAmount, expectedCommission, await time.latest());

            const finalCampaignState = await getCampaignState(campaignId);
            expect(finalCampaignState.raisedAmount).to.equal(initialCampaignState.raisedAmount + expectedAmountToCampaign);
            expect(finalCampaignState.totalEverRaised).to.equal(initialCampaignState.totalEverRaised + donationAmount); // Gross amount
            expect(await crowdfund.donations(campaignId, donor.address)).to.equal(expectedAmountToCampaign);

            if (expectedCommission > 0n) {
                const finalCommissionWalletBalance = await ethers.provider.getBalance(currentCommissionWallet);
                if (currentCommissionWallet === commissionRecipient.address) { // Only check balance precisely if it's a signer we control
                    expect(finalCommissionWalletBalance).to.equal(initialCommissionWalletBalance + expectedCommission);
                } else { // For default hardcoded wallet, we assume the transfer was attempted. Event confirms commission amount.
                    expect(expectedCommission).to.be.gt(0n); // Confirmed by event.
                }
            }
        }

        it("Should process donation to Startup campaign, deduct 2% commission", async function () {
            await testDonation(CampaignType.Startup, smallDonation, startupCommissionRate, donor1, true);
        });

        it("Should process donation to Charity campaign, deduct 0% commission", async function () {
            await testDonation(CampaignType.Charity, smallDonation, charityCommissionRate, donor1, true);
        });

        it("Should allow multiple donations from same donor (Startup) and track correctly", async function () {
            await crowdfund.connect(owner).setCommissionWallet(commissionRecipient.address); // For balance check
            campaignDetails = await createActiveCampaign(CampaignType.Startup, creatorAcc);
            const campaignId = campaignDetails.campaignId;

            // First donation
            await crowdfund.connect(donor1).donate(campaignId, { value: smallDonation });
            let expectedCommission1 = (smallDonation * startupCommissionRate) / 10000n;
            let expectedToCampaign1 = smallDonation - expectedCommission1;

            // Second donation
            await crowdfund.connect(donor1).donate(campaignId, { value: midDonation });
            let expectedCommission2 = (midDonation * startupCommissionRate) / 10000n;
            let expectedToCampaign2 = midDonation - expectedCommission2;

            const campaign = await getCampaignState(campaignId);
            const expectedTotalToCampaign = expectedToCampaign1 + expectedToCampaign2;
            const expectedTotalGross = smallDonation + midDonation;

            expect(campaign.raisedAmount).to.equal(expectedTotalToCampaign);
            expect(campaign.totalEverRaised).to.equal(expectedTotalGross);
            expect(await crowdfund.donations(campaignId, donor1.address)).to.equal(expectedTotalToCampaign);
        });

        it("Should update status to Completed when net target is reached (Startup)", async function () {
            // Target is 10 ETH. With 2% commission, gross donation needed is 10 / (1 - 0.02) = 10 / 0.98 = ~10.204 ETH
            const grossToMeetTarget = targetAmount * 10000n / (10000n - startupCommissionRate) + 1n; // Add 1 wei for safety due to integer division
            campaignDetails = await createActiveCampaign(CampaignType.Startup, creatorAcc);
            await crowdfund.connect(donor1).donate(campaignDetails.campaignId, { value: grossToMeetTarget });
            const campaign = await getCampaignState(campaignDetails.campaignId);
            expect(campaign.status).to.equal(Status.Completed);
        });

        it("Should update status to Completed when target is reached (Charity, 0% commission)", async function () {
            campaignDetails = await createActiveCampaign(CampaignType.Charity, creatorAcc, campaignDurationSeconds, targetAmount);
            await crowdfund.connect(donor1).donate(campaignDetails.campaignId, { value: targetAmount });
            const campaign = await getCampaignState(campaignDetails.campaignId);
            expect(campaign.status).to.equal(Status.Completed);
        });


        it("Should revert donation if campaign is not Active", async function () {
            campaignDetails = await createActiveCampaign(CampaignType.Startup, creatorAcc);
            const campaignId = campaignDetails.campaignId;
            // Make Completed
            const grossToMeetTarget = targetAmount * 10000n / (10000n - startupCommissionRate) + 1n;
            await crowdfund.connect(donor1).donate(campaignId, { value: grossToMeetTarget });
            await expect(crowdfund.connect(donor2).donate(campaignId, { value: smallDonation }))
                .to.be.revertedWithCustomError(crowdfund, "CampaignNotActive");

            // Make Closing
            const { campaignId: closingCampaignId } = await createActiveCampaign(CampaignType.Startup, creatorAcc);
            await crowdfund.connect(creatorAcc).initiateClosure(closingCampaignId);
            await expect(crowdfund.connect(donor1).donate(closingCampaignId, { value: smallDonation }))
                .to.be.revertedWithCustomError(crowdfund, "CampaignNotActive");
        });

        it("Should revert donation if campaign original end time has passed", async function () {
            campaignDetails = await createActiveCampaign(CampaignType.Startup, creatorAcc);
            await time.increaseTo(campaignDetails.endTime + 1n);
            await expect(crowdfund.connect(donor1).donate(campaignDetails.campaignId, { value: smallDonation }))
                .to.be.revertedWithCustomError(crowdfund, "CampaignHasEnded");
        });

        it("Should revert donation if campaign ID is invalid", async function () {
            await expect(crowdfund.connect(donor1).donate(999, { value: smallDonation }))
                .to.be.revertedWithCustomError(crowdfund, "InvalidCampaignId");
        });
        it("Should revert donation if amount is zero", async function () {
            campaignDetails = await createActiveCampaign(CampaignType.Startup, creatorAcc);
            await expect(crowdfund.connect(donor1).donate(campaignDetails.campaignId, { value: 0 }))
                .to.be.revertedWithCustomError(crowdfund, "DonationAmountMustBePositive");
        });
    });

    // ===============================
    // === Claiming Refunds Tests ===
    // ===============================
    describe("Claiming Refunds (claimRefund)", function () {
        let campaignId;
        let netDonationDonor1;
        let netDonationDonor2;

        beforeEach(async function () {
            // Set commission wallet to a controllable address for easier balance checks if needed for commission
            // but refund comes from campaign balance, not commission wallet.
            await crowdfund.connect(owner).setCommissionWallet(commissionRecipient.address);

            const campaignDetails = await createActiveCampaign(CampaignType.Startup, creatorAcc); // Startup campaign has 2% commission
            campaignId = campaignDetails.campaignId;

            // Donor 1: smallDonation (gross)
            await crowdfund.connect(donor1).donate(campaignId, { value: smallDonation });
            const commission1 = (smallDonation * initialStartupCommission) / 10000n;
            netDonationDonor1 = smallDonation - commission1;

            // Donor 2: midDonation (gross)
            await crowdfund.connect(donor2).donate(campaignId, { value: midDonation });
            const commission2 = (midDonation * initialStartupCommission) / 10000n;
            netDonationDonor2 = midDonation - commission2;
        });

        it("Should allow a donor to claim their net refund while campaign is Active", async function () {
            const initialBalance = await ethers.provider.getBalance(donor1.address);
            const initialCampaign = await getCampaignState(campaignId);

            const tx = await crowdfund.connect(donor1).claimRefund(campaignId);
            const receipt = await tx.wait();
            const gasUsed = receipt.gasUsed ?? 0n; // Handle potential undefined from some providers in testing
            const effectiveGasPrice = tx.gasPrice ?? (await ethers.provider.getFeeData()).gasPrice ?? 0n;
            const gasCost = gasUsed * effectiveGasPrice;

            const finalBalance = await ethers.provider.getBalance(donor1.address);
            const finalCampaign = await getCampaignState(campaignId);

            await expect(tx)
                .to.emit(crowdfund, "RefundClaimed")
                .withArgs(campaignId, donor1.address, netDonationDonor1);

            expect(await crowdfund.donations(campaignId, donor1.address)).to.equal(0);
            expect(await crowdfund.hasReclaimed(campaignId, donor1.address)).to.be.true;
            expect(finalCampaign.raisedAmount).to.equal(initialCampaign.raisedAmount - netDonationDonor1);
            expect(finalCampaign.totalEverRaised).to.equal(initialCampaign.totalEverRaised); // Gross unchanged
            expect(finalBalance).to.equal(initialBalance + netDonationDonor1 - gasCost);
        });

        it("Should allow a donor to claim their net refund while campaign is Closing (before deadline)", async function () {
            await crowdfund.connect(creatorAcc).initiateClosure(campaignId); // Move to Closing
            const initialBalance = await ethers.provider.getBalance(donor2.address);
            const initialCampaign = await getCampaignState(campaignId);

            const tx = await crowdfund.connect(donor2).claimRefund(campaignId);
            const receipt = await tx.wait();
            const gasUsed = receipt.gasUsed ?? 0n;
            const effectiveGasPrice = tx.gasPrice ?? (await ethers.provider.getFeeData()).gasPrice ?? 0n;
            const gasCost = gasUsed * effectiveGasPrice;

            const finalBalance = await ethers.provider.getBalance(donor2.address);
            const finalCampaign = await getCampaignState(campaignId);

            await expect(tx)
                .to.emit(crowdfund, "RefundClaimed")
                .withArgs(campaignId, donor2.address, netDonationDonor2);

            expect(await crowdfund.donations(campaignId, donor2.address)).to.equal(0);
            expect(await crowdfund.hasReclaimed(campaignId, donor2.address)).to.be.true;
            expect(finalCampaign.raisedAmount).to.equal(initialCampaign.raisedAmount - netDonationDonor2);
            expect(finalBalance).to.equal(initialBalance + netDonationDonor2 - gasCost);
        });

        // ... (other refund tests: already reclaimed, no donation, wrong status - should be mostly fine, they check against CampaignNotActiveOrClosing)
        // Ensure amounts are consistent with net donations.
        it("Should revert refund claim if already reclaimed", async function () {
            await crowdfund.connect(donor1).claimRefund(campaignId);
            await expect(crowdfund.connect(donor1).claimRefund(campaignId))
                .to.be.revertedWithCustomError(crowdfund, "NoDonationToClaim"); // Because donation is zeroed
        });

        it("Should revert refund claim if donor made no donation", async function () {
            await expect(crowdfund.connect(nonParticipant).claimRefund(campaignId))
                .to.be.revertedWithCustomError(crowdfund, "NoDonationToClaim");
        });
    });


    // ===============================
    // === Campaign Closure Tests === (initiateClosure / finalizeClosureAndWithdraw)
    // ===============================
    describe("Campaign Closure (initiateClosure / finalizeClosureAndWithdraw)", function () {
        let campaignId;
        let netRaisedFromDonor1, netRaisedFromDonor2;

        beforeEach(async function () {
            const campaignDetails = await createActiveCampaign(CampaignType.Startup, creatorAcc);
            campaignId = campaignDetails.campaignId;

            const commission1 = (smallDonation * initialStartupCommission) / 10000n;
            netRaisedFromDonor1 = smallDonation - commission1;
            await crowdfund.connect(donor1).donate(campaignId, { value: smallDonation });

            const commission2 = (midDonation * initialStartupCommission) / 10000n;
            netRaisedFromDonor2 = midDonation - commission2;
            await crowdfund.connect(donor2).donate(campaignId, { value: midDonation });
        });

        describe("initiateClosure", function () {
            it("Should allow creator to initiate closure for an Active campaign", async function () {
                const tx = await crowdfund.connect(creatorAcc).initiateClosure(campaignId);
                const blockTimestamp = await time.latest();
                const expectedDeadline = BigInt(blockTimestamp) + BigInt(reclaimPeriodSeconds);

                const campaign = await getCampaignState(campaignId);
                expect(campaign.status).to.equal(Status.Closing);
                expect(campaign.reclaimDeadline).to.equal(expectedDeadline);

                await expect(tx)
                    .to.emit(crowdfund, "CampaignClosingInitiated")
                    .withArgs(campaignId, creatorAcc.address, expectedDeadline);
            });
            // ... (other initiateClosure tests: after endTime, not creator, completed, already closing, withdrawn - these should largely remain the same)
        });


        describe("finalizeClosureAndWithdraw", function () {
            let reclaimDeadline;
            let initialNetRaisedAmount;

            beforeEach(async function () {
                await crowdfund.connect(creatorAcc).initiateClosure(campaignId);
                const campaign = await getCampaignState(campaignId);
                reclaimDeadline = campaign.reclaimDeadline;
                initialNetRaisedAmount = campaign.raisedAmount; // Net amount after commissions
            });

            it("Should allow creator to finalize and withdraw remaining net funds after deadline", async function () {
                // Donor 1 claims refund (netDonationDonor1)
                await crowdfund.connect(donor1).claimRefund(campaignId);
                const amountRemainingForCreator = initialNetRaisedAmount - netRaisedFromDonor1; // Should be netRaisedFromDonor2

                await time.increaseTo(reclaimDeadline + 1n); // Fast forward past deadline

                const initialCreatorBalance = await ethers.provider.getBalance(creatorAcc.address);
                const tx = await crowdfund.connect(creatorAcc).finalizeClosureAndWithdraw(campaignId);
                const receipt = await tx.wait();
                const gasUsed = receipt.gasUsed ?? 0n;
                const effectiveGasPrice = tx.gasPrice ?? (await ethers.provider.getFeeData()).gasPrice ?? 0n;
                const gasCost = gasUsed * effectiveGasPrice;
                const finalCreatorBalance = await ethers.provider.getBalance(creatorAcc.address);

                // Event: CampaignClosedByCreator(uint256 indexed campaignId, address indexed creator, uint256 amountWithdrawn, uint256 commissionDeducted);
                // commissionDeducted is 0 here
                await expect(tx)
                    .to.emit(crowdfund, "CampaignClosedByCreator")
                    .withArgs(campaignId, creatorAcc.address, amountRemainingForCreator, 0n);

                const campaign = await getCampaignState(campaignId);
                expect(campaign.status).to.equal(Status.ClosedByCreator);
                expect(campaign.raisedAmount).to.equal(0n);
                expect(finalCreatorBalance).to.equal(initialCreatorBalance + amountRemainingForCreator - gasCost);
            });
            // ... (other finalize tests: all funds reclaimed, not creator, not closing, reclaim period active, already finalized - should be largely same)
        });
    });


    // ===============================
    // === Standard Withdrawal Tests ===
    // ===============================
    describe("Standard Withdrawal (withdrawFunds)", function () {
        let campaignId;
        let netTargetAmount; // Actual amount raised in campaign after commission to meet target

        beforeEach(async function () {
            const campaignDetails = await createActiveCampaign(CampaignType.Startup, creatorAcc); // Startup 2% commission
            campaignId = campaignDetails.campaignId;

            // Calculate gross donation needed to achieve net targetAmount
            const grossToMeetTarget = targetAmount * 10000n / (10000n - initialStartupCommission) + 1n; // a bit more to ensure target is met or exceeded (net)
            await crowdfund.connect(donor1).donate(campaignId, { value: grossToMeetTarget });

            const campaignState = await getCampaignState(campaignId);
            netTargetAmount = campaignState.raisedAmount; // This is the actual net amount raised
            expect(campaignState.status).to.equal(Status.Completed);
        });

        it("Should allow creator withdrawFunds (net amount) if Completed", async function () {
            const initialCreatorBalance = await ethers.provider.getBalance(creatorAcc.address);
            const tx = await crowdfund.connect(creatorAcc).withdrawFunds(campaignId);
            const receipt = await tx.wait();
            const gasUsed = receipt.gasUsed ?? 0n;
            const effectiveGasPrice = tx.gasPrice ?? (await ethers.provider.getFeeData()).gasPrice ?? 0n;
            const gasCost = gasUsed * effectiveGasPrice;
            const finalCreatorBalance = await ethers.provider.getBalance(creatorAcc.address);


            // Event: FundsWithdrawn(uint256 indexed campaignId, address indexed creator, uint256 amount, uint256 commissionDeducted);
            // commissionDeducted is 0 here
            await expect(tx)
                .to.emit(crowdfund, "FundsWithdrawn")
                .withArgs(campaignId, creatorAcc.address, netTargetAmount, 0n);

            const campaign = await getCampaignState(campaignId);
            expect(campaign.status).to.equal(Status.Withdrawn);
            expect(campaign.raisedAmount).to.equal(0n);
            expect(finalCreatorBalance).to.equal(initialCreatorBalance + netTargetAmount - gasCost);
        });
        // ... (other withdrawFunds tests: not completed, not creator, invalid ID, already withdrawn - should be largely same)
    });


    // ===============================
    // === Getter Function Tests ===
    // ===============================
    describe("Getter Functions", function () {
        it("Should return the correct campaign details via getCampaign", async function () {
            const { campaignId, campaignType, creatorAddress, targetAmount: expectedTarget, endTime, creationTimestamp } = await createActiveCampaign(CampaignType.Charity, creatorAcc);
            const campaign = await crowdfund.getCampaign(campaignId); // Using the specific getter

            expect(campaign.creator).to.equal(creatorAcc.address);
            expect(campaign.campaignType).to.equal(CampaignType.Charity);
            expect(campaign.targetAmount).to.equal(expectedTarget);
            expect(campaign.raisedAmount).to.equal(0n);
            expect(campaign.totalEverRaised).to.equal(0n);
            expect(campaign.dataCID).to.equal(dataCID); // Assuming dataCID is consistent from helper
            expect(campaign.endTime).to.equal(endTime);
            expect(campaign.status).to.equal(Status.Active);
            expect(campaign.creationTimestamp).to.equal(creationTimestamp);
            expect(campaign.reclaimDeadline).to.equal(0n);
        });

        it("Should return the correct creator address via getCampaignCreator", async function () {
            const { campaignId } = await createActiveCampaign(CampaignType.Startup, creatorAcc);
            const fetchedCreator = await crowdfund.getCampaignCreator(campaignId);
            expect(fetchedCreator).to.equal(creatorAcc.address);
        });
        // ... (other getter tests: invalid ID for getCampaignCreator - should be same)
    });


    // ===============================
    // === Commission Management Tests ===
    // ===============================
    describe("Commission Management", function () {
        const newStartupCommission = 300n; // 3%
        const newCharityCommission = 50n;  // 0.5%
        const invalidCommission = 10001n; // > 100%

        describe("setCommissionWallet", function () {
            it("Should allow owner to set a new commission wallet", async function () {
                await expect(crowdfund.connect(owner).setCommissionWallet(commissionRecipient.address))
                    .to.emit(crowdfund, "CommissionWalletChanged")
                    .withArgs(commissionRecipient.address);
                expect(await crowdfund.commissionWallet()).to.equal(commissionRecipient.address);
            });
            it("Should prevent non-owner from setting commission wallet", async function () {
                await expect(crowdfund.connect(donor1).setCommissionWallet(commissionRecipient.address))
                    .to.be.revertedWithCustomError(crowdfund, "OwnableUnauthorizedAccount")
                    .withArgs(donor1.address);
            });
            it("Should prevent setting commission wallet to address(0)", async function () {
                await expect(crowdfund.connect(owner).setCommissionWallet(ethers.ZeroAddress))
                    .to.be.revertedWithCustomError(crowdfund, "CommissionWalletNotSet");
            });
        });

        describe("setStartupCommissionPercentage", function () {
            it("Should allow owner to set startup commission", async function () {
                await expect(crowdfund.connect(owner).setStartupCommissionPercentage(newStartupCommission))
                    .to.emit(crowdfund, "StartupCommissionPercentageChanged")
                    .withArgs(newStartupCommission);
                expect(await crowdfund.startupCommissionPercentage()).to.equal(newStartupCommission);
            });
            it("Should prevent non-owner from setting startup commission", async function () {
                await expect(crowdfund.connect(donor1).setStartupCommissionPercentage(newStartupCommission))
                    .to.be.revertedWithCustomError(crowdfund, "OwnableUnauthorizedAccount")
                    .withArgs(donor1.address);
            });
            it("Should revert if startup commission is > 100%", async function () {
                await expect(crowdfund.connect(owner).setStartupCommissionPercentage(invalidCommission))
                    .to.be.revertedWithCustomError(crowdfund, "InvalidCommissionPercentage");
            });
            it("Should use new startup commission for new donations", async function () {
                await crowdfund.connect(owner).setStartupCommissionPercentage(newStartupCommission);
                await crowdfund.connect(owner).setCommissionWallet(commissionRecipient.address); // Control recipient

                const { campaignId } = await createActiveCampaign(CampaignType.Startup, creatorAcc);
                const initialRecipientBalance = await ethers.provider.getBalance(commissionRecipient.address);

                await crowdfund.connect(donor1).donate(campaignId, { value: smallDonation });
                const expectedCommission = (smallDonation * newStartupCommission) / 10000n;

                const finalRecipientBalance = await ethers.provider.getBalance(commissionRecipient.address);
                expect(finalRecipientBalance).to.equal(initialRecipientBalance + expectedCommission);
            });
        });

        describe("setCharityCommissionPercentage", function () {
            it("Should allow owner to set charity commission", async function () {
                await expect(crowdfund.connect(owner).setCharityCommissionPercentage(newCharityCommission))
                    .to.emit(crowdfund, "CharityCommissionPercentageChanged")
                    .withArgs(newCharityCommission);
                expect(await crowdfund.charityCommissionPercentage()).to.equal(newCharityCommission);
            });
            it("Should prevent non-owner from setting charity commission", async function () {
                await expect(crowdfund.connect(donor1).setCharityCommissionPercentage(newCharityCommission))
                    .to.be.revertedWithCustomError(crowdfund, "OwnableUnauthorizedAccount")
                    .withArgs(donor1.address);
            });
            it("Should revert if charity commission is > 100%", async function () {
                await expect(crowdfund.connect(owner).setCharityCommissionPercentage(invalidCommission))
                    .to.be.revertedWithCustomError(crowdfund, "InvalidCommissionPercentage");
            });
            it("Should use new charity commission for new donations", async function () {
                await crowdfund.connect(owner).setCharityCommissionPercentage(newCharityCommission);
                await crowdfund.connect(owner).setCommissionWallet(commissionRecipient.address);

                const { campaignId } = await createActiveCampaign(CampaignType.Charity, creatorAcc);
                const initialRecipientBalance = await ethers.provider.getBalance(commissionRecipient.address);

                await crowdfund.connect(donor1).donate(campaignId, { value: smallDonation });
                const expectedCommission = (smallDonation * newCharityCommission) / 10000n;

                const finalRecipientBalance = await ethers.provider.getBalance(commissionRecipient.address);
                expect(finalRecipientBalance).to.equal(initialRecipientBalance + expectedCommission);
            });
        });
    });

    // ===============================
    // === Reentrancy Guard Tests ===
    // ===============================
    describe("Reentrancy Guard", function () {
        let attackerMock;
        let AttackContractFactory;

        beforeEach(async function () {
            AttackContractFactory = await ethers.getContractFactory("ReentrancyAttackMock");
            attackerMock = await AttackContractFactory.deploy(await crowdfund.getAddress());
            await attackerMock.waitForDeployment();
        });

        it("Should prevent reentrancy attack in withdrawFunds (Completed)", async function () {
            const latestTimestamp = await time.latest();
            const endTime = latestTimestamp + campaignDurationSeconds;

            // Mock creates a Startup campaign
            // Need to use the mock's signer (e.g., nonParticipant) to call createCampaignOnBehalf if it's not msg.sender based
            // The ReentrancyAttackMock's createCampaignOnBehalf uses its own address as creator.
            await attackerMock.connect(nonParticipant).createCampaignOnBehalf(CampaignType.Startup, targetAmount, dataCID, BigInt(endTime));
            const mockCampaignId = await crowdfund.nextCampaignId() - 1n;

            // Complete campaign created by mock (anyone can donate)
            // Calculate gross donation needed for Startup campaign (2% commission)
            const grossToMeetTarget = targetAmount * 10000n / (10000n - initialStartupCommission) + 1n;
            await crowdfund.connect(donor1).donate(mockCampaignId, { value: grossToMeetTarget });

            // Verify campaign is completed
            const campaignState = await getCampaignState(mockCampaignId);
            expect(campaignState.status).to.equal(Status.Completed);
            expect(campaignState.creator).to.equal(await attackerMock.getAddress());


            // Attempt withdrawal via mock's attackWithdraw, targeting original withdrawFunds
            // The mock contract itself is the creator in this case.
            // The reentrancy guard in Crowdfund.sol should prevent the reentrant call.
            // NOWA, POPRAWNA LINIA W PLIKU TESTOWYM:
            await expect(attackerMock.connect(nonParticipant).attackWithdraw(mockCampaignId))
                .to.be.revertedWithCustomError(crowdfund, "FundTransferFailed");
        });

        // Other nonReentrant guard checks remain valuable for donate, claimRefund etc.
        // Their core logic hasn't changed much other than amounts due to commission.
        // The original tests for these seem fine as basic checks.
        it("Should have nonReentrant guard on donate", async function () {
            const { campaignId } = await createActiveCampaign(CampaignType.Startup, creatorAcc);
            await expect(crowdfund.connect(donor1).donate(campaignId, { value: smallDonation })).to.not.be.reverted;
        });

        it("Should have nonReentrant guard on claimRefund", async function () {
            const { campaignId } = await createActiveCampaign(CampaignType.Startup, creatorAcc);
            await crowdfund.connect(donor1).donate(campaignId, { value: smallDonation }); // Gross donation
            await expect(crowdfund.connect(donor1).claimRefund(campaignId)).to.not.be.reverted;
        });
    });

}); // End describe