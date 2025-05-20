// Import necessary libraries and helpers
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

// Main test suite for the Crowdfund contract (v5.5.1 - ERC20, Advanced Commissions)
describe("Crowdfund (v5.5.1 - ERC20, Advanced Commissions, based on v4.1 tests)", function () {
    // Shared variables for tests
    let Crowdfund, crowdfund;
    let MockERC20, mockERC20;
    let owner, creatorAcc, donor1, donor2, nonParticipant, commissionRecipient;

    // Token Configuration
    const tokenName = "MockToken";
    const tokenSymbol = "MKT";
    const tokenDecimals = 18;
    const parseToken = (amountStr) => ethers.parseUnits(String(amountStr), tokenDecimals);

    // Campaign and donation amounts in token units
    const targetAmountTokens = parseToken("1000");
    const smallDonationTokens = parseToken("100");
    const midDonationTokens = parseToken("400");
    const largeDonationTokens = parseToken("1100");

    // Other constants
    const dataCID = "QmW2WDa7vK7f5fJvvj39p6j8P2k6PjMhAW5tC3Mph5g8N";
    const campaignDurationSeconds = 3600; // 1 hour
    const reclaimPeriodSeconds = 14 * 24 * 60 * 60; // 14 days

    // Initial commission percentages (basis points)
    const initialStartupDonationCommPerc = 200n; // 2.00%
    const initialCharityDonationCommPerc = 50n;   // 0.50%
    const initialRefundCommPerc = 1000n;         // 10.00%
    const initialStartupSuccessCommPerc = 500n;  // 5.00%
    const initialCharitySuccessCommPerc = 100n;  // 1.00%

    // Enums matching the contract
    const Status = {
        Active: 0n,
        Completed: 1n,
        Closing: 2n,
        Withdrawn: 3n,
        ClosedByCreator: 4n,
        Failed: 5n,
    };
    const CampaignType = { Startup: 0n, Charity: 1n };

    let crowdfundAddress;
    let mockERC20Address;

    beforeEach(async function () {
        [owner, creatorAcc, donor1, donor2, nonParticipant, commissionRecipient] = await ethers.getSigners();

        // Deploy MockERC20 token
        MockERC20 = await ethers.getContractFactory("MockERC20");
        mockERC20 = await MockERC20.deploy(tokenName, tokenSymbol, tokenDecimals, 0, owner.address);
        await mockERC20.waitForDeployment();
        mockERC20Address = await mockERC20.getAddress();

        // Mint tokens for owner and distribute
        await mockERC20.connect(owner).mint(owner.address, parseToken("1000000"));
        await mockERC20.connect(owner).transfer(creatorAcc.address, parseToken("50000"));
        await mockERC20.connect(owner).transfer(donor1.address, parseToken("50000"));
        await mockERC20.connect(owner).transfer(donor2.address, parseToken("50000"));

        // Deploy Crowdfund contract
        Crowdfund = await ethers.getContractFactory("Crowdfund");
        crowdfund = await Crowdfund.deploy(
            owner.address,
            commissionRecipient.address,
            initialStartupDonationCommPerc,
            initialCharityDonationCommPerc,
            initialRefundCommPerc,
            initialStartupSuccessCommPerc,
            initialCharitySuccessCommPerc
        );
        await crowdfund.waitForDeployment();
        crowdfundAddress = await crowdfund.getAddress();

        // Whitelist the mockERC20 token
        await crowdfund.connect(owner).addAcceptedToken(mockERC20Address, tokenSymbol);
    });

    async function createActiveCampaign(
        campaignType = CampaignType.Startup,
        creatorSigner = creatorAcc,
        durationSeconds = campaignDurationSeconds,
        customTarget = targetAmountTokens,
        acceptedTokenAddr = mockERC20Address
    ) {
        const latestTimestamp = await time.latest();
        const endTime = BigInt(latestTimestamp) + BigInt(durationSeconds);
        const tx = await crowdfund.connect(creatorSigner).createCampaign(
            campaignType,
            acceptedTokenAddr,
            customTarget,
            dataCID,
            endTime
        );
        const receipt = await tx.wait();
        const logs = receipt.logs
            .map(log => {
                try { return crowdfund.interface.parseLog(log); }
                catch (e) { return null; }
            })
            .filter(log => log !== null);
        const campaignCreatedEvent = logs.find(log => log.name === "CampaignCreated");
        if (!campaignCreatedEvent) throw new Error("CampaignCreated event not found.");
        return {
            campaignId: campaignCreatedEvent.args.campaignId,
            campaignType: campaignCreatedEvent.args.campaignType,
            creatorAddress: campaignCreatedEvent.args.creator,
            acceptedToken: campaignCreatedEvent.args.acceptedToken,
            targetAmount: campaignCreatedEvent.args.targetAmount,
            endTime: campaignCreatedEvent.args.endTime,
            creationTimestamp: campaignCreatedEvent.args.creationTimestamp
        };
    }

    async function getCampaignState(campaignId) {
        return await crowdfund.getCampaignDetails(campaignId);
    }

    describe("Contract Initialization", function () {
        it("Should set the correct owner", async function () {
            expect(await crowdfund.owner()).to.equal(owner.address);
        });
        it("Should set the initial commission wallet", async function () {
            expect(await crowdfund.commissionWallet()).to.equal(commissionRecipient.address);
        });
        it("Should set initial startup donation commission percentage", async function () {
            expect(await crowdfund.startupDonationCommissionPercentage()).to.equal(initialStartupDonationCommPerc);
        });
        it("Should set initial charity donation commission percentage", async function () {
            expect(await crowdfund.charityDonationCommissionPercentage()).to.equal(initialCharityDonationCommPerc);
        });
        it("Should set initial refund commission percentage", async function () {
            expect(await crowdfund.refundCommissionPercentage()).to.equal(initialRefundCommPerc);
        });
        it("Should set initial startup success commission percentage", async function () {
            expect(await crowdfund.startupSuccessCommissionPercentage()).to.equal(initialStartupSuccessCommPerc);
        });
        it("Should set initial charity success commission percentage", async function () {
            expect(await crowdfund.charitySuccessCommissionPercentage()).to.equal(initialCharitySuccessCommPerc);
        });
    });

    describe("Campaign Creation", function () {
        it("Should create a Startup campaign with correct initial state", async function () {
            const latestTimestamp = await time.latest();
            const endTime = BigInt(latestTimestamp) + BigInt(campaignDurationSeconds);
            const tx = await crowdfund.connect(creatorAcc).createCampaign(
                CampaignType.Startup,
                mockERC20Address,
                targetAmountTokens,
                dataCID,
                endTime
            );
            const campaignId = 1n;

            await expect(tx)
                .to.emit(crowdfund, "CampaignCreated")
                .withArgs(
                    campaignId,
                    creatorAcc.address,
                    mockERC20Address,
                    CampaignType.Startup,
                    targetAmountTokens,
                    dataCID,
                    endTime,
                    (ts) => ts >= latestTimestamp && ts <= BigInt(latestTimestamp + 10)
                );

            const campaign = await getCampaignState(campaignId);
            expect(campaign.creator).to.equal(creatorAcc.address);
            expect(campaign.acceptedToken).to.equal(mockERC20Address);
            expect(campaign.campaignType).to.equal(CampaignType.Startup);
            expect(campaign.targetAmount).to.equal(targetAmountTokens);
            expect(campaign.raisedAmount).to.equal(0n);
            expect(campaign.totalEverRaised).to.equal(0n);
            expect(campaign.dataCID).to.equal(dataCID);
            expect(campaign.endTime).to.equal(endTime);
            expect(campaign.status).to.equal(Status.Active);
            expect(campaign.creationTimestamp).to.be.gt(0n);
            expect(campaign.reclaimDeadline).to.equal(0n);
        });

        it("Should create a Charity campaign with correct initial state", async function () {
            const latestTimestamp = await time.latest();
            const endTime = BigInt(latestTimestamp) + BigInt(campaignDurationSeconds);
            await createActiveCampaign();
            const nextId = await crowdfund.nextCampaignId();

            const tx = await crowdfund.connect(creatorAcc).createCampaign(
                CampaignType.Charity,
                mockERC20Address,
                targetAmountTokens,
                dataCID,
                endTime
            );

            await expect(tx)
                .to.emit(crowdfund, "CampaignCreated")
                .withArgs(
                    nextId,
                    creatorAcc.address,
                    mockERC20Address,
                    CampaignType.Charity,
                    targetAmountTokens,
                    dataCID,
                    endTime,
                    (ts) => ts >= latestTimestamp && ts <= BigInt(latestTimestamp + 10)
                );
            const campaign = await getCampaignState(nextId);
            expect(campaign.campaignType).to.equal(CampaignType.Charity);
        });

        it("Should revert campaign creation if target amount is zero", async function () {
            const endTime = BigInt(await time.latest()) + BigInt(campaignDurationSeconds);
            await expect(crowdfund.connect(creatorAcc).createCampaign(
                CampaignType.Startup,
                mockERC20Address,
                0,
                dataCID,
                endTime
            )).to.be.revertedWithCustomError(crowdfund, "TargetAmountMustBePositive");
        });

        it("Should revert campaign creation if end time is not in the future", async function () {
            const pastTime = BigInt(await time.latest()) - BigInt(1000);
            await expect(crowdfund.connect(creatorAcc).createCampaign(
                CampaignType.Startup,
                mockERC20Address,
                targetAmountTokens,
                dataCID,
                pastTime
            )).to.be.revertedWithCustomError(crowdfund, "EndTimeNotInFuture");
        });

        it("Should revert campaign creation if data CID is empty", async function () {
            const endTime = BigInt(await time.latest()) + BigInt(campaignDurationSeconds);
            await expect(crowdfund.connect(creatorAcc).createCampaign(
                CampaignType.Startup,
                mockERC20Address,
                targetAmountTokens,
                "",
                endTime
            )).to.be.revertedWithCustomError(crowdfund, "DataCIDCannotBeEmpty");
        });

        it("Should revert campaign creation if token is not whitelisted", async function () {
            const unlistedToken = ethers.Wallet.createRandom().address;
            const endTime = BigInt(await time.latest()) + BigInt(campaignDurationSeconds);
            await expect(crowdfund.connect(creatorAcc).createCampaign(
                CampaignType.Startup,
                unlistedToken,
                targetAmountTokens,
                dataCID,
                endTime
            )).to.be.revertedWithCustomError(crowdfund, "TokenNotWhitelisted").withArgs(unlistedToken);
        });
    });

    describe("Donations (ERC20)", function () {
        let campaignId;

        beforeEach(async function() {
            const campaignDetails = await createActiveCampaign(CampaignType.Startup);
            campaignId = campaignDetails.campaignId;
        });

        // Helper function for donation checks - poprawka: cumulativeNet
        async function makeAndCheckDonation(donor, amount, campId, donationCommRate, expectedCumulativeNet) {
            const [ initialDonorBalance, initialCommBalance, initialCfBalance ] =
                await Promise.all([
                  mockERC20.balanceOf(donor.address),
                  mockERC20.balanceOf(commissionRecipient.address),
                  mockERC20.balanceOf(crowdfundAddress)
                ]);

            await mockERC20.connect(donor).approve(crowdfundAddress, amount);
            const tx = await crowdfund.connect(donor).donate(campId, amount);

            const expectedComm = (amount * donationCommRate) / 10000n;
            const expectedNet = amount - expectedComm;

            await expect(tx).to.emit(crowdfund, "DonationReceived").withArgs(
                campId,
                donor.address,
                mockERC20Address,
                amount,
                expectedNet,
                expectedComm,
                await time.latest()
            );

            // balances
            expect(await mockERC20.balanceOf(donor.address)).to.equal(initialDonorBalance - amount);
            expect(await mockERC20.balanceOf(commissionRecipient.address)).to.equal(initialCommBalance + expectedComm);
            expect(await mockERC20.balanceOf(crowdfundAddress)).to.equal(initialCfBalance + expectedNet);

            // mapping
            expect(await crowdfund.donations(campId, donor.address)).to.equal(expectedCumulativeNet);
        }

        it("Should process Startup donation, deduct startupDonationCommission", async function () {
            const expectedNet = smallDonationTokens - (smallDonationTokens * initialStartupDonationCommPerc / 10000n);
            await makeAndCheckDonation(donor1, smallDonationTokens, campaignId, initialStartupDonationCommPerc, expectedNet);
        });

        it("Should process Charity donation, deduct charityDonationCommission", async function () {
            const { campaignId: charityCampaignId } = await createActiveCampaign(CampaignType.Charity);
            const expectedNet = smallDonationTokens - (smallDonationTokens * initialCharityDonationCommPerc / 10000n);
            await makeAndCheckDonation(donor1, smallDonationTokens, charityCampaignId, initialCharityDonationCommPerc, expectedNet);
        });

        it("Should allow multiple donations from same donor and update balances correctly", async function () {
            // Pierwsza donacja
            const expectedNet1 = smallDonationTokens - (smallDonationTokens * initialStartupDonationCommPerc / 10000n);
            let cumulativeNet = expectedNet1;
            await makeAndCheckDonation(donor1, smallDonationTokens, campaignId, initialStartupDonationCommPerc, cumulativeNet);

            // Druga donacja
            const expectedNet2 = midDonationTokens - (midDonationTokens * initialStartupDonationCommPerc / 10000n);
            cumulativeNet += expectedNet2;
            await makeAndCheckDonation(donor1, midDonationTokens, campaignId, initialStartupDonationCommPerc, cumulativeNet);
        });

        it("Should update status to Completed when net target is reached", async function () {
            const grossToMeetTarget = (targetAmountTokens * 10000n) / (10000n - initialStartupDonationCommPerc) + 1n;
            await mockERC20.connect(donor1).approve(crowdfundAddress, grossToMeetTarget);
            await crowdfund.connect(donor1).donate(campaignId, grossToMeetTarget);
            const campaign = await getCampaignState(campaignId);
            expect(campaign.status).to.equal(Status.Completed);
        });

        it("Should revert donation if campaign is not Active (e.g. Completed)", async function () {
            const grossToMeetTarget = (targetAmountTokens * 10000n) / (10000n - initialStartupDonationCommPerc) + 1n;
            await mockERC20.connect(donor1).approve(crowdfundAddress, grossToMeetTarget);
            await crowdfund.connect(donor1).donate(campaignId, grossToMeetTarget);
            await mockERC20.connect(donor2).approve(crowdfundAddress, smallDonationTokens);
            await expect(crowdfund.connect(donor2).donate(campaignId, smallDonationTokens))
                .to.be.revertedWithCustomError(crowdfund, "CampaignNotActive");
        });

        it("Should revert donation if campaign original end time has passed", async function () {
            const camp = await getCampaignState(campaignId);
            await time.increaseTo(camp.endTime + 1n);
            await mockERC20.connect(donor1).approve(crowdfundAddress, smallDonationTokens);
            await expect(crowdfund.connect(donor1).donate(campaignId, smallDonationTokens))
                .to.be.revertedWithCustomError(crowdfund, "CampaignHasEnded");
        });

        it("Should revert donation if amount is zero", async function () {
            await mockERC20.connect(donor1).approve(crowdfundAddress, 0);
            await expect(crowdfund.connect(donor1).donate(campaignId, 0))
                .to.be.revertedWithCustomError(crowdfund, "DonationAmountMustBePositive");
        });

        it("Should revert donation if insufficient allowance", async function () {
            await mockERC20.connect(donor1).approve(crowdfundAddress, smallDonationTokens - 1n);
            await expect(crowdfund.connect(donor1).donate(campaignId, smallDonationTokens))
                .to.be.revertedWithCustomError(crowdfund, "InsufficientTokenAllowance");
        });
    });

    describe("Claiming Refunds (ERC20)", function () {
        let campaignId;
        let netDonationByDonor1;

        beforeEach(async function() {
            const { campaignId: cid } = await createActiveCampaign(CampaignType.Startup);
            campaignId = cid;
            await mockERC20.connect(donor1).approve(crowdfundAddress, midDonationTokens);
            await crowdfund.connect(donor1).donate(campaignId, midDonationTokens);
            netDonationByDonor1 = midDonationTokens - (midDonationTokens * initialStartupDonationCommPerc / 10000n);
        });

        it("Should allow donor to claim refund (with refund commission) if Active", async function () {
            const [initialDonorBal, initialCommBal, initialCfBal] = await Promise.all([
              mockERC20.balanceOf(donor1.address),
              mockERC20.balanceOf(commissionRecipient.address),
              mockERC20.balanceOf(crowdfundAddress)
            ]);

            const tx = await crowdfund.connect(donor1).claimRefund(campaignId);

            const expectedRefundComm = (netDonationByDonor1 * initialRefundCommPerc) / 10000n;
            const expectedAmountToDonor = netDonationByDonor1 - expectedRefundComm;

            await expect(tx).to.emit(crowdfund, "RefundClaimed")
                .withArgs(campaignId, donor1.address, mockERC20Address, expectedAmountToDonor, expectedRefundComm);

            expect(await mockERC20.balanceOf(donor1.address)).to.equal(initialDonorBal + expectedAmountToDonor);
            expect(await mockERC20.balanceOf(commissionRecipient.address)).to.equal(initialCommBal + expectedRefundComm);
            expect(await mockERC20.balanceOf(crowdfundAddress)).to.equal(initialCfBal - netDonationByDonor1);
            expect(await crowdfund.donations(campaignId, donor1.address)).to.equal(0);
            expect(await crowdfund.hasReclaimed(campaignId, donor1.address)).to.be.true;
        });

        it("Should allow donor to claim full refund (NO refund commission) if campaign Failed", async function () {
            const camp = await getCampaignState(campaignId);
            await time.increaseTo(camp.endTime + 1n);
            await crowdfund.connect(nonParticipant).failCampaignIfUnsuccessful(campaignId);
            expect((await getCampaignState(campaignId)).status).to.equal(Status.Failed);

            const [initialDonorBal, initialCommBal] = await Promise.all([
              mockERC20.balanceOf(donor1.address),
              mockERC20.balanceOf(commissionRecipient.address)
            ]);

            const tx = await crowdfund.connect(donor1).claimRefund(campaignId);

            await expect(tx).to.emit(crowdfund, "RefundClaimed")
                .withArgs(campaignId, donor1.address, mockERC20Address, netDonationByDonor1, 0n);

            expect(await mockERC20.balanceOf(donor1.address)).to.equal(initialDonorBal + netDonationByDonor1);
            expect(await mockERC20.balanceOf(commissionRecipient.address)).to.equal(initialCommBal);
        });

        // ... (Add other refund tests: Closing state, already reclaimed, no donation, invalid status, reclaim period over for Closing)
    });

    describe("Campaign Closure and Withdrawals (ERC20)", function () {
        // ... (Tests for initiateClosure, finalizeClosureAndWithdraw - adapt from Ether based tests, using token balances)
    });

    describe("Standard Withdrawal from Completed Campaign (ERC20)", function () {
        let campaignId;
        let netRaisedInCampaign;

        beforeEach(async function() {
            await crowdfund.connect(owner).setStartupSuccessCommissionPercentage(initialStartupSuccessCommPerc);

            const campDetails = await createActiveCampaign(CampaignType.Startup, creatorAcc, campaignDurationSeconds, targetAmountTokens);
            campaignId = campDetails.campaignId;

            const grossToMeetTarget = (targetAmountTokens * 10000n) / (10000n - initialStartupDonationCommPerc) + 1n;
            await mockERC20.connect(donor1).approve(crowdfundAddress, grossToMeetTarget);
            await crowdfund.connect(donor1).donate(campaignId, grossToMeetTarget);

            const campState = await getCampaignState(campaignId);
            expect(campState.status).to.equal(Status.Completed);
            netRaisedInCampaign = campState.raisedAmount;
        });

        it("Should allow creator to withdraw from Completed campaign with success commission", async function () {
            const [initialCreatorBal, initialCommBal] = await Promise.all([
              mockERC20.balanceOf(creatorAcc.address),
              mockERC20.balanceOf(commissionRecipient.address)
            ]);

            const tx = await crowdfund.connect(creatorAcc).withdrawFunds(campaignId);

            const expectedSuccessComm = (netRaisedInCampaign * initialStartupSuccessCommPerc) / 10000n;
            const expectedAmountToCreator = netRaisedInCampaign - expectedSuccessComm;

            await expect(tx).to.emit(crowdfund, "FundsWithdrawn")
                .withArgs(campaignId, creatorAcc.address, mockERC20Address, expectedAmountToCreator, expectedSuccessComm);

            expect(await mockERC20.balanceOf(creatorAcc.address)).to.equal(initialCreatorBal + expectedAmountToCreator);
            expect(await mockERC20.balanceOf(commissionRecipient.address)).to.equal(initialCommBal + expectedSuccessComm);

            const finalCampState = await getCampaignState(campaignId);
            expect(finalCampState.status).to.equal(Status.Withdrawn);
            expect(finalCampState.raisedAmount).to.equal(0n);
        });
        // ... (More withdrawal tests: charity success commission, 0% success commission, not creator, not completed etc.)
    });

    describe("Reentrancy Guard (Conceptual for ERC20)", function () {
        let attackerMock;
        let AttackContractFactory;
        let mockCampaignIdByAttacker;

        beforeEach(async function () {
            AttackContractFactory = await ethers.getContractFactory("ReentrancyAttackMock");
            attackerMock = await AttackContractFactory.deploy(crowdfundAddress);
            await attackerMock.waitForDeployment();
            const attackerAddress = await attackerMock.getAddress();

            // Attacker creates a campaign (as itself)
            await attackerMock.createCampaignOnBehalf(
                CampaignType.Startup,
                mockERC20Address,
                parseToken("10"),
                "attack_cid",
                (await time.latest()) + 3600
            );
            mockCampaignIdByAttacker = await crowdfund.nextCampaignId() - 1n;

            // Fund attacker's campaign to completion
            const donationForAttackersCampaign = parseToken("10") * 10000n / (10000n - initialStartupDonationCommPerc) + 1n;
            await mockERC20.connect(donor2).approve(crowdfundAddress, donationForAttackersCampaign);
            await crowdfund.connect(donor2).donate(mockCampaignIdByAttacker, donationForAttackersCampaign);

            const campaignState = await getCampaignState(mockCampaignIdByAttacker);
            expect(campaignState.status).to.equal(Status.Completed);
            expect(campaignState.creator).to.equal(attackerAddress);
        });

        it("withdrawFunds should be protected by ReentrancyGuard", async function () {
            await expect(
                attackerMock.attackWithdraw(mockCampaignIdByAttacker)
            ).to.not.be.revertedWith("ReentrancyGuard: reentrant call");
        });
    });

    describe("Commissions for multiple ERC20 tokens", function () {
        let usdcMock, otherToken;
        let campaignUSDC, campaignOTH;

        beforeEach(async function () {
            // Deploy a USDC-like token (6 decimals) and whitelist it
            const USDC = await ethers.getContractFactory("MockERC20");
            usdcMock = await USDC.deploy("USD Coin", "USDC", 6, 0, owner.address);
            await usdcMock.waitForDeployment();
            await usdcMock.connect(owner).mint(donor1.address, ethers.parseUnits("1000", 6));
            await crowdfund.connect(owner).addAcceptedToken(await usdcMock.getAddress(), "USDC");

            // Deploy another token (18 decimals) and whitelist it
            const OTH = await ethers.getContractFactory("MockERC20");
            otherToken = await OTH.deploy("Other Token", "OTH", 18, 0, owner.address);
            await otherToken.waitForDeployment();
            await otherToken.connect(owner).mint(donor2.address, parseToken("1000"));
            await crowdfund.connect(owner).addAcceptedToken(await otherToken.getAddress(), "OTH");

            // Create a Startup campaign in USDC
            campaignUSDC = await createActiveCampaign(
                CampaignType.Startup,
                creatorAcc,
                campaignDurationSeconds,
                ethers.parseUnits("500", 6),
                await usdcMock.getAddress()
            );
            // Create a Charity campaign in OTH
            campaignOTH = await createActiveCampaign(
                CampaignType.Charity,
                creatorAcc,
                campaignDurationSeconds,
                parseToken("300"),
                await otherToken.getAddress()
            );
        });

        it("Should deduct correct commission for USDC donations (6 decimals)", async function () {
            const amount = ethers.parseUnits("100", 6);
            await usdcMock.connect(donor1).approve(crowdfundAddress, amount);
            const [ initCommBal, initCfBal ] = await Promise.all([
              usdcMock.balanceOf(commissionRecipient.address),
              usdcMock.balanceOf(crowdfundAddress)
            ]);

            const tx = await crowdfund.connect(donor1).donate(campaignUSDC.campaignId, amount);

            const expectedComm = amount * initialStartupDonationCommPerc / 10000n;
            const expectedNet  = amount - expectedComm;

            await expect(tx).to.emit(crowdfund, "DonationReceived").withArgs(
                campaignUSDC.campaignId,
                donor1.address,
                await usdcMock.getAddress(),
                amount,
                expectedNet,
                expectedComm,
                await time.latest()
            );
            expect(await usdcMock.balanceOf(commissionRecipient.address)).to.equal(initCommBal + expectedComm);
            expect(await usdcMock.balanceOf(crowdfundAddress)).to.equal(initCfBal + expectedNet);
        });

        it("Should deduct correct commission for OtherToken donations (18 decimals)", async function () {
            const amount = parseToken("200");
            await otherToken.connect(donor2).approve(crowdfundAddress, amount);
            const [ initCommBal, initCfBal ] = await Promise.all([
              otherToken.balanceOf(commissionRecipient.address),
              otherToken.balanceOf(crowdfundAddress)
            ]);

            const tx = await crowdfund.connect(donor2).donate(campaignOTH.campaignId, amount);

            const expectedComm = amount * initialCharityDonationCommPerc / 10000n;
            const expectedNet  = amount - expectedComm;

            await expect(tx).to.emit(crowdfund, "DonationReceived").withArgs(
                campaignOTH.campaignId,
                donor2.address,
                await otherToken.getAddress(),
                amount,
                expectedNet,
                expectedComm,
                await time.latest()
            );
            expect(await otherToken.balanceOf(commissionRecipient.address)).to.equal(initCommBal + expectedComm);
            expect(await otherToken.balanceOf(crowdfundAddress)).to.equal(initCfBal + expectedNet);
        });
    });

});
