// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import "./Crowdfund.sol"; // Upewnij się, że ta ścieżka jest poprawna
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title Reentrancy Attack Simulation Contract (for ERC20 Crowdfund)
 * @author [Twoje Imię/Nazwa Firmy/Pseudonim Developera]
 * @notice This contract is designed to interact with an ERC20-based Crowdfund contract for testing purposes,
 * including simulating conditions for reentrancy attacks.
 * @dev It's crucial to understand that the classic Ether-based reentrancy vector (via `receive()`)
 * will likely NOT be triggered by Crowdfund.sol's ERC20 token transfers (e.g., during `withdrawFunds`).
 * True reentrancy testing in an ERC20 context might require a malicious token (e.g., ERC777 with hooks)
 * or a different callback pattern within the main contract if one were to exist.
 * This mock helps call functions with correct signatures and set up scenarios.
 */
contract ReentrancyAttackMock {
    Crowdfund public immutable crowdfundContract;
    uint256 private lastAttackedCampaignId; // Stores the ID of the campaign targeted in an attack sequence

    event MockCampaignCreated(uint256 indexed campaignId, address indexed acceptedToken);
    event ReentrancyAttemptTriggered(uint256 campaignId, uint256 gasAvailable);
    event AttackDonateCalled(uint256 campaignId, uint256 donationAmount);

    /**
     * @notice Constructor that links this mock to a deployed Crowdfund contract instance.
     * @param _crowdfundAddress The address of the Crowdfund contract to be tested.
     */
    constructor(address _crowdfundAddress) {
        require(_crowdfundAddress != address(0), "ReentrancyAttackMock: Invalid Crowdfund address");
        crowdfundContract = Crowdfund(_crowdfundAddress);
    }

    /**
     * @notice Allows an external caller to instruct this mock contract to create a new campaign
     * on the linked Crowdfund contract. This mock will be the campaign's creator.
     * @param _campaignType The type of the campaign (Startup or Charity).
     * @param _acceptedTokenAddress The ERC20 token address for the campaign's funds.
     * @param _targetAmount The fundraising goal in the smallest units of the accepted token.
     * @param _dataCID A content identifier (e.g., IPFS CID) for campaign details.
     * @param _endTime The Unix timestamp for the campaign's deadline.
     */
    function createCampaignOnBehalf(
        Crowdfund.CampaignType _campaignType,
        address _acceptedTokenAddress,
        uint256 _targetAmount,
        string memory _dataCID,
        uint256 _endTime
    ) public {
        // Call the updated createCampaign function in Crowdfund.sol
        crowdfundContract.createCampaign(
            _campaignType,
            _acceptedTokenAddress,
            _targetAmount,
            _dataCID,
            _endTime
        );

        // Attempt to get the ID of the created campaign for event emission
        // Note: nextCampaignId is incremented *before* campaign creation in Crowdfund.sol
        uint256 currentNextId = crowdfundContract.nextCampaignId();
        if (currentNextId > 1) { // Ensures at least one campaign was attempted to be created
            emit MockCampaignCreated(currentNextId - 1, _acceptedTokenAddress);
        }
    }

    /**
     * @notice Initiates a call to the `donate` function of the Crowdfund contract.
     * @dev This function is NOT payable. For a donation to succeed, the `Crowdfund` contract
     * must have been approved to spend `_donationAmount` of the relevant tokens from the caller
     * (or this mock contract, if it holds and donates tokens).
     * This mock function mainly serves to test the call signature and set `lastAttackedCampaignId`.
     * @param _campaignId The ID of the campaign to donate to.
     * @param _donationAmount The amount of tokens to attempt to donate.
     */
    function attackDonate(uint256 _campaignId, uint256 _donationAmount) public {
        lastAttackedCampaignId = _campaignId;
        crowdfundContract.donate(_campaignId, _donationAmount);
        emit AttackDonateCalled(_campaignId, _donationAmount);
    }

    /**
     * @notice Initiates a call to the `withdrawFunds` function of the Crowdfund contract.
     * @dev This mock contract must be the creator of the campaign `_campaignId` for this to succeed.
     * The reentrancy attempt via this contract's `receive()` function is unlikely to be triggered
     * by `Crowdfund.sol`'s `withdrawFunds` if it correctly transfers ERC20 tokens, not Ether.
     * @param _campaignId The ID of the campaign from which to attempt withdrawal.
     */
    function attackWithdraw(uint256 _campaignId) public {
        lastAttackedCampaignId = _campaignId;
        crowdfundContract.withdrawFunds(_campaignId);
    }

    /**
     * @notice Fallback `receive` function, intended to be triggered by Ether transfers.
     * @dev CRITICAL NOTE FOR ERC20 CROWDFUND:
     * This `receive()` function is designed for Ether-based reentrancy.
     * The `Crowdfund.sol` contract, in its ERC20 version, uses `token.transfer()` for withdrawals
     * and refunds to creators/donors. Standard ERC20 `transfer` calls DO NOT send Ether and
     * WILL NOT trigger this `receive()` function in the recipient contract.
     * Therefore, this specific reentrancy vector (re-entering `attackWithdraw` via an Ether payment
     * received during a `withdrawFunds` call from `Crowdfund.sol`) IS NOT directly applicable
     * to the current ERC20-based `Crowdfund.sol`.
     *
     * To test reentrancy vulnerabilities in an ERC20 context effectively, one might need to:
     * 1. Use a malicious token (e.g., ERC777 with `tokensReceived` hooks) as the `acceptedToken`.
     * 2. Identify other potential callback patterns within `Crowdfund.sol` (if any exist).
     *
     * The `ReentrancyGuard` in `Crowdfund.sol` should protect its functions from typical reentrancy.
     * This `receive` function is left here for conceptual illustration but its effectiveness
     * for the current `Crowdfund.sol` is highly diminished.
     */
    receive() external payable {
        uint256 campaignIdToAttack = lastAttackedCampaignId;

        if (campaignIdToAttack > 0) { // Ensure there's a campaign context
            uint256 gas = gasleft();
            emit ReentrancyAttemptTriggered(campaignIdToAttack, gas);

            // Check for sufficient gas for a reentrant call attempt.
            // This threshold (e.g., 60000) is arbitrary.
            if (gas > 60000) {
                // Attempt the reentrant call. As noted, this is unlikely to be triggered
                // by Crowdfund.sol's ERC20 token withdrawal.
                // If it were somehow triggered, and attackWithdraw calls Crowdfund.sol again,
                // the ReentrancyGuard in Crowdfund.sol should prevent the reentrancy.
                // this.attackWithdraw(campaignIdToAttack);
                // Consider what function to call for a meaningful test if a callback does occur.
                // For now, commenting out the direct re-attack as its premise is flawed here.
                // If a reentrancy test IS being set up through other means (e.g. malicious token),
                // then this is where the reentrant logic would go.
            }
        }
    }

    /**
     * @notice Helper to check the Ether balance of this mock contract.
     * @return The current Ether balance in Wei.
     */
    function getBalance() public view returns (uint256) {
        return address(this).balance;
    }

    /**
     * @notice Helper to check the ERC20 token balance of this mock contract.
     * @param _tokenAddress The address of the ERC20 token.
     * @return The token balance of this contract for the specified token.
     */
    function getTokenBalance(address _tokenAddress) public view returns (uint256) {
        if (_tokenAddress == address(0)) {
            // Or revert, depending on desired behavior for invalid token address
            return 0;
        }
        return IERC20(_tokenAddress).balanceOf(address(this));
    }
}