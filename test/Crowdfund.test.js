// Import necessary libraries and helpers
const { expect } = require("chai"); // Assertion library
const { ethers } = require("hardhat"); // Hardhat's Ethers.js plugin
const { time } = require("@nomicfoundation/hardhat-network-helpers"); // Hardhat time manipulation helpers

// Main test suite for the Crowdfund contract
describe("Crowdfund", function () {
    // Shared variables for tests in this suite
    let Crowdfund;        // Contract factory
    let crowdfund;        // Deployed contract instance
    let creator;          // Signer object for the campaign creator account
    let donor1;           // Signer object for the first donor account
    let donor2;           // Signer object for the second donor account
    let nonParticipant;   // Signer object for an account not involved initially

    // Define constants used in tests
    const targetAmount = ethers.parseEther("10"); // Target amount: 10 ETH
    const smallDonation = ethers.parseEther("1"); // Small donation amount
    const dataCID = "QmW2WDa7vK7f5fJvvj39p6j8P2k6PjMhAW5tC3Mph5g8N"; // Example IPFS CID
    const campaignDurationSeconds = 3600; // Default campaign duration: 1 hour

    // `beforeEach` hook runs before every `it` test case in this `describe` block
    beforeEach(async function () {
        // Get signer objects (representing Ethereum accounts) provided by Hardhat
        [creator, donor1, donor2, nonParticipant] = await ethers.getSigners();
        // Get the contract factory for the "Crowdfund" contract (using the version with Custom Errors)
        Crowdfund = await ethers.getContractFactory("Crowdfund");
        // Deploy a fresh instance of the Crowdfund contract
        crowdfund = await Crowdfund.deploy();
        // Wait for the deployment transaction to be confirmed
        await crowdfund.deploymentTransaction()?.wait();
    });

    // --- Helper Function to Create Campaigns ---
    async function createNewCampaign(creatorSigner = creator, durationSeconds = campaignDurationSeconds, customTarget = targetAmount, customCID = dataCID) {
        const latestTimestamp = await time.latest();
        const endTime = latestTimestamp + durationSeconds;
        const tx = await crowdfund.connect(creatorSigner).createCampaign(customTarget, customCID, BigInt(endTime));
        const receipt = await tx.wait();
        const campaignCreatedEvent = receipt?.logs?.find(log => log.fragment?.name === "CampaignCreated");
        if (!campaignCreatedEvent) {
            throw new Error("CampaignCreated event not found in transaction logs.");
        }
        return {
            campaignId: campaignCreatedEvent.args.campaignId,
            endTime: BigInt(endTime)
        };
    }
    // --- End Helper Function ---

    // ==================================
    // === Campaign Creation Tests ===
    // ==================================
    describe("Campaign Creation", function () {
        it("Should create a campaign with correct details", async function () {
            const latestTimestamp = await time.latest();
            const endTime = latestTimestamp + campaignDurationSeconds;
            const tx = await crowdfund.connect(creator).createCampaign(targetAmount, dataCID, BigInt(endTime));
            const campaignId = await crowdfund.nextCampaignId() - 1n; // Get the ID of the created campaign

            // Assert event emission
            await expect(tx)
                .to.emit(crowdfund, "CampaignCreated")
                .withArgs(campaignId, creator.address, targetAmount, dataCID, BigInt(endTime), (await time.latest())); // Timestamp check might be slightly off, check range or omit if flaky

            // Assert campaign state
            const campaign = await crowdfund.campaigns(campaignId);
            expect(campaign.creator).to.equal(creator.address);
            expect(campaign.targetAmount).to.equal(targetAmount);
            expect(campaign.raisedAmount).to.equal(0n);
            expect(campaign.dataCID).to.equal(dataCID);
            expect(campaign.endTime).to.equal(BigInt(endTime));
            expect(campaign.status).to.equal(0); // 0: Active
            expect(campaign.creationTimestamp).to.be.gt(0n); // Should be set
        });

        it("Should revert campaign creation if target amount is zero", async function () {
            const latestTimestamp = await time.latest();
            const endTime = latestTimestamp + campaignDurationSeconds;
            await expect(crowdfund.connect(creator).createCampaign(0, dataCID, BigInt(endTime)))
                .to.be.revertedWithCustomError(crowdfund, "TargetAmountMustBePositive");
        });

        it("Should revert campaign creation if end time is not in the future", async function () {
            const pastTime = (await time.latest()); // Exactly current time, should fail
            await expect(crowdfund.connect(creator).createCampaign(targetAmount, dataCID, BigInt(pastTime)))
                .to.be.revertedWithCustomError(crowdfund, "EndTimeNotInFuture");

             const pastTime2 = (await time.latest()) - 1; // Time in the past
             await expect(crowdfund.connect(creator).createCampaign(targetAmount, dataCID, BigInt(pastTime2)))
                .to.be.revertedWithCustomError(crowdfund, "EndTimeNotInFuture");
        });

        it("Should revert campaign creation if data CID is empty", async function () {
            const latestTimestamp = await time.latest();
            const endTime = latestTimestamp + campaignDurationSeconds;
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
            // Create a campaign before each donation test
            const result = await createNewCampaign();
            campaignId = result.campaignId;
            endTime = result.endTime;
        });

        it("Should allow a donor to donate", async function () {
            const donationAmount = ethers.parseEther("1");
            const tx = await crowdfund.connect(donor1).donate(campaignId, { value: donationAmount });

            // Assert event
            await expect(tx)
                .to.emit(crowdfund, "DonationReceived")
                .withArgs(campaignId, donor1.address, donationAmount, (await time.latest()));

            // Assert state change
            const campaign = await crowdfund.campaigns(campaignId);
            expect(campaign.raisedAmount).to.equal(donationAmount);
        });

        it("Should allow multiple donors to donate", async function () {
            const donation1 = ethers.parseEther("2");
            const donation2 = ethers.parseEther("3");
            await crowdfund.connect(donor1).donate(campaignId, { value: donation1 });
            await crowdfund.connect(donor2).donate(campaignId, { value: donation2 });

            const campaign = await crowdfund.campaigns(campaignId);
            expect(campaign.raisedAmount).to.equal(donation1 + donation2);
        });

        it("Should update campaign status to Completed when target is reached", async function () {
            const donationAmount = targetAmount; // Donate exact target
            await crowdfund.connect(donor1).donate(campaignId, { value: donationAmount });

            const campaign = await crowdfund.campaigns(campaignId);
            expect(campaign.status).to.equal(2); // 2: Completed
        });

         it("Should update campaign status to Completed when target is exceeded", async function () {
            const donationAmount = targetAmount + ethers.parseEther("1"); // Exceed target
            await crowdfund.connect(donor1).donate(campaignId, { value: donationAmount });

            const campaign = await crowdfund.campaigns(campaignId);
            expect(campaign.status).to.equal(2); // 2: Completed
        });

        it("Should revert donation if campaign ID is invalid", async function () {
            const invalidId = 999;
            await expect(crowdfund.connect(donor1).donate(invalidId, { value: smallDonation }))
                .to.be.revertedWithCustomError(crowdfund, "InvalidCampaignId");
        });

        it("Should revert donation if campaign is not active (Completed)", async function () {
            // Reach target
            await crowdfund.connect(donor1).donate(campaignId, { value: targetAmount });
            // Try donating again
            await expect(crowdfund.connect(donor2).donate(campaignId, { value: smallDonation }))
                .to.be.revertedWithCustomError(crowdfund, "CampaignNotActive");
        });

        it("Should revert donation if campaign is not active (Cancelled)", async function () {
            // Cancel campaign
            await crowdfund.connect(creator).cancelCampaign(campaignId);
            // Try donating
            await expect(crowdfund.connect(donor1).donate(campaignId, { value: smallDonation }))
                .to.be.revertedWithCustomError(crowdfund, "CampaignNotActive");
        });

        it("Should revert donation if campaign has ended", async function () {
            // Fast forward time
            await time.increaseTo(endTime + 1n);
            // Try donating
            await expect(crowdfund.connect(donor1).donate(campaignId, { value: smallDonation }))
                .to.be.revertedWithCustomError(crowdfund, "CampaignHasEnded");
        });

        it("Should revert donation if amount is zero", async function () {
            await expect(crowdfund.connect(donor1).donate(campaignId, { value: 0 }))
                .to.be.revertedWithCustomError(crowdfund, "DonationAmountMustBePositive");
        });
    });

    // ===============================
    // === Withdrawal Logic Tests ===
    // ===============================
     describe("Withdrawal", function () {
        let campaignId;

        beforeEach(async function() {
            // Create campaign and meet target before each withdrawal test
            const result = await createNewCampaign();
            campaignId = result.campaignId;
            await crowdfund.connect(donor1).donate(campaignId, { value: targetAmount }); // Meet target exactly
            // Verify status is Completed
            const campaign = await crowdfund.campaigns(campaignId);
            expect(campaign.status).to.equal(2); // 2: Completed
        });

        it("Should allow the creator to withdraw funds after the target is reached", async function () {
            const initialCreatorBalance = await ethers.provider.getBalance(creator.address);
            const tx = await crowdfund.connect(creator).withdrawFunds(campaignId);
            const receipt = await tx.wait();
            const finalCreatorBalance = await ethers.provider.getBalance(creator.address);
            const gasCost = BigInt(receipt?.gasUsed ?? 0n) * BigInt(tx.gasPrice ?? 0n);

            // Check event
            await expect(tx)
                .to.emit(crowdfund, "FundsWithdrawn")
                .withArgs(campaignId, creator.address, targetAmount);

            // Check final state
            const campaign = await crowdfund.campaigns(campaignId);
            expect(campaign.status).to.equal(3); // 3: Withdrawn
            expect(campaign.raisedAmount).to.equal(0n);

            // Check balance change
            expect(finalCreatorBalance).to.equal(initialCreatorBalance + targetAmount - gasCost);
        });

        it("Should revert withdrawal if campaign ID is invalid", async function () {
             await expect(crowdfund.connect(creator).withdrawFunds(999))
                .to.be.revertedWithCustomError(crowdfund, "InvalidCampaignId");
        });

        it("Should revert withdrawal if caller is not the creator", async function () {
            await expect(crowdfund.connect(donor1).withdrawFunds(campaignId))
                .to.be.revertedWithCustomError(crowdfund, "NotCampaignCreator");
        });

        it("Should revert withdrawal if campaign is not completed (Active)", async function () {
            // Create a new campaign that hasn't met the target
            const { campaignId: activeCampaignId } = await createNewCampaign();
            await crowdfund.connect(donor1).donate(activeCampaignId, { value: smallDonation }); // Donate less than target
            await expect(crowdfund.connect(creator).withdrawFunds(activeCampaignId))
                .to.be.revertedWithCustomError(crowdfund, "CampaignNotCompleted");
        });

         it("Should revert withdrawal if campaign is not completed (Cancelled)", async function () {
            // Create campaign, donate some, then cancel
            const { campaignId: cancelledCampaignId } = await createNewCampaign();
            await crowdfund.connect(donor1).donate(cancelledCampaignId, { value: smallDonation });
            await crowdfund.connect(creator).cancelCampaign(cancelledCampaignId);
            await expect(crowdfund.connect(creator).withdrawFunds(cancelledCampaignId))
                .to.be.revertedWithCustomError(crowdfund, "CampaignNotCompleted");
        });

        it("Should revert withdrawal if funds have already been withdrawn", async function () {
            // Withdraw once successfully
            await crowdfund.connect(creator).withdrawFunds(campaignId);
            // Try withdrawing again
            await expect(crowdfund.connect(creator).withdrawFunds(campaignId))
                .to.be.revertedWithCustomError(crowdfund, "CampaignNotCompleted"); // Status is now Withdrawn, not Completed
        });

         // Note: Testing FundTransferFailed is difficult without a specific mock receiver contract
         // that reverts on receiving funds. Skipping this specific test case for now.
         // it("Should revert withdrawal if fund transfer fails", async function () { ... });

         // Test removed as NoFundsToWithdraw is not reachable due to CampaignNotCompleted check
         // it("Should revert withdrawal if raised amount is somehow zero...", async function () { ... });

    });

    // ===============================
    // === Cancellation Logic Tests ===
    // ===============================
    describe("Cancellation", function () {
        let campaignId;
        let endTime;

         beforeEach(async function() {
            // Create a campaign before each cancellation test
            const result = await createNewCampaign();
            campaignId = result.campaignId;
            endTime = result.endTime;
        });

        it("Should allow creator to cancel campaign if active and before end time", async function () {
            const tx = await crowdfund.connect(creator).cancelCampaign(campaignId);
            // Check event
            await expect(tx)
                .to.emit(crowdfund, "CampaignCancelled")
                .withArgs(campaignId, creator.address, (await time.latest()));
            // Check state
            const campaign = await crowdfund.campaigns(campaignId);
            expect(campaign.status).to.equal(1); // 1: Cancelled
        });

        it("Should revert cancellation if campaign ID is invalid", async function () {
             await expect(crowdfund.connect(creator).cancelCampaign(999))
                .to.be.revertedWithCustomError(crowdfund, "InvalidCampaignId");
        });

        it("Should revert cancellation if caller is not the creator", async function () {
            await expect(crowdfund.connect(donor1).cancelCampaign(campaignId))
                .to.be.revertedWithCustomError(crowdfund, "NotCampaignCreator");
        });

        it("Should revert cancellation if campaign is not active (Completed)", async function () {
            // Reach target
            await crowdfund.connect(donor1).donate(campaignId, { value: targetAmount });
            // Try cancelling
            await expect(crowdfund.connect(creator).cancelCampaign(campaignId))
                .to.be.revertedWithCustomError(crowdfund, "CampaignNotActive");
        });

         it("Should revert cancellation if campaign is not active (Withdrawn)", async function () {
            // Reach target and withdraw
            await crowdfund.connect(donor1).donate(campaignId, { value: targetAmount });
            await crowdfund.connect(creator).withdrawFunds(campaignId);
            // Try cancelling
            await expect(crowdfund.connect(creator).cancelCampaign(campaignId))
                .to.be.revertedWithCustomError(crowdfund, "CampaignNotActive");
        });

        it("Should revert cancellation if campaign end time has passed", async function () {
             // Fast forward time
            await time.increaseTo(endTime + 1n);
            // Try cancelling
            await expect(crowdfund.connect(creator).cancelCampaign(campaignId))
                .to.be.revertedWithCustomError(crowdfund, "CannotCancelAfterEndTime");
        });
    });

    // ===============================
    // === Getter Function Tests ===
    // ===============================
     describe("Getter Functions", function () {
         it("Should return the correct creator address", async function () {
            const { campaignId } = await createNewCampaign();
            const fetchedCreator = await crowdfund.getCampaignCreator(campaignId);
            expect(fetchedCreator).to.equal(creator.address);
         });

         it("Should revert getting creator if campaign ID is invalid", async function () {
             await expect(crowdfund.getCampaignCreator(999))
                .to.be.revertedWithCustomError(crowdfund, "InvalidCampaignId");
         });
     });

    // ===============================
    // === Reentrancy Guard Tests ===
    // ===============================
    describe("Reentrancy Guard", function () {
        let attackContract;
        let campaignId;

        beforeEach(async function() {
            // Deploy mock attack contract
            const AttackContract = await ethers.getContractFactory("ReentrancyAttackMock");
            attackContract = await AttackContract.deploy(await crowdfund.getAddress());
            await attackContract.deploymentTransaction()?.wait();

            // --- CORRECTED TIMESTAMP CALCULATION ---
            // Calculate the correct absolute future end time
            const latestTimestamp = await time.latest();
            const endTimeAbsolute = latestTimestamp + campaignDurationSeconds;

            // Attacker creates a campaign via the mock contract, passing the absolute end time
            const tx = await attackContract.connect(nonParticipant).createCampaignOnBehalf(
                targetAmount,
                dataCID,
                BigInt(endTimeAbsolute) // Pass the calculated absolute BigInt endTime
            );
            // --- END CORRECTION ---

            const receipt = await tx.wait();

            // Reliably get campaign ID (assuming mock doesn't emit it reliably)
            const nextId = await crowdfund.nextCampaignId();
             if (nextId > 1) {
                 campaignId = nextId - 1n;
             } else {
                 throw new Error("Could not determine campaign ID created by mock in beforeEach");
             }
             expect(campaignId).to.be.gt(0); // Ensure campaignId was set
        });

        it("Should execute donate successfully via mock (validating setup)", async function () {
            const donationAmount = ethers.parseEther("1");
            // nonParticipant donates via the attack contract
            await expect(attackContract.connect(nonParticipant).attackDonate(campaignId, { value: donationAmount }))
                .to.not.be.reverted;

            const campaign = await crowdfund.campaigns(campaignId);
            expect(campaign.raisedAmount).to.equal(donationAmount);
        });

        it("Should prevent reentrancy attack in withdrawFunds", async function () {
            // 1. Campaign created by mock in beforeEach
            expect(campaignId).to.be.gt(0); // Ensure campaignId is valid

            // 2. Donate enough to complete the campaign via the mock contract
            await attackContract.connect(nonParticipant).attackDonate(campaignId, { value: targetAmount });
            const campaign = await crowdfund.campaigns(campaignId);
            expect(campaign.status).to.equal(2); // Check status is Completed

            // 3. Attempt withdrawal via the mock contract's attackWithdraw function
            // --- CORRECTED ASSERTION (FINAL) ---
            // Expect the FundTransferFailed error, which is the observable result
            // of the ReentrancyGuard preventing the reentrant call within the mock's receive().
            await expect(attackContract.connect(nonParticipant).attackWithdraw(campaignId))
                .to.be.revertedWithCustomError(crowdfund, "FundTransferFailed");
            // --- END CORRECTION ---
        });

         // Test removed as donate reentrancy isn't the focus and mock isn't set up for it
         // it("Should prevent reentrancy attack in donate", async function () { ... });
    });

}); // End of the describe block for "Crowdfund"
