// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./Crowdfund.sol"; // Ensure this path points to your Crowdfund contract

/**
 * @title Reentrancy Attack Simulation Contract
 * @dev Used in Hardhat tests to simulate reentrancy attacks against Crowdfund.
 * Includes functionality to create campaigns on behalf of itself for testing creator-restricted functions.
 */
contract ReentrancyAttackMock {
    // The target Crowdfund contract instance
    Crowdfund public immutable crowdfundContract;
    // Stores the ID of the campaign being targeted in the current attack sequence
    uint256 private lastAttackedCampaignId;

    // Event emitted when the mock successfully creates a campaign via createCampaignOnBehalf
    event MockCampaignCreated(uint256 indexed campaignId);
    // Event emitted just before attempting a reentrant call (for debugging/visibility in tests)
    event ReentrancyAttemptTriggered(uint256 campaignId, uint256 gasAvailable);

    /**
     * @dev Constructor stores the address of the Crowdfund contract to interact with.
     * @param _crowdfundAddress The deployed address of the Crowdfund contract under test.
     */
    constructor(address _crowdfundAddress) {
        crowdfundContract = Crowdfund(_crowdfundAddress);
        // Note: 'owner' variable from previous version removed as it's not needed
        // for the corrected 'withdrawFunds' test strategy.
    }

    /**
     * @notice Allows an external account to instruct this mock contract to create a campaign.
     * @dev This contract's address will be recorded as the 'creator' in the Crowdfund contract.
     * Emits MockCampaignCreated event with the new campaign ID upon successful creation.
     * @param _targetAmount Target fundraising amount for the campaign.
     * @param _dataCID Identifier (e.g., IPFS hash) for campaign details.
     * @param _endTime Unix timestamp for the campaign's end.
     */
    function createCampaignOnBehalf(
        uint256 _targetAmount,
        string memory _dataCID,
        uint256 _endTime
    ) public {
        // Call the target contract's createCampaign function.
        // Because *this* contract is calling it, its address becomes msg.sender -> creator.
        crowdfundContract.createCampaign(_targetAmount, _dataCID, _endTime);

        // Reliably get the created campaign ID by reading the nextCampaignId *after* creation.
        // Assumes nextCampaignId increments correctly in the target contract.
        uint256 currentNextId = crowdfundContract.nextCampaignId();
        // Check if currentNextId is greater than 1 (meaning at least one campaign exists)
        if (currentNextId > 1) {
             // The ID of the campaign just created is the previous value of nextCampaignId
             emit MockCampaignCreated(currentNextId - 1);
        }
        // Consider adding error handling if createCampaign might revert (e.g., invalid endTime)
        // although the test setup should provide valid parameters.
    }

    /**
     * @notice Initiates a donation call to the target Crowdfund contract.
     * @dev Used to test the 'donate' function's nonReentrant guard, although
     * this specific vector doesn't trigger reentrancy via Ether transfer.
     * @param _campaignId The ID of the campaign to donate to.
     */
    function attackDonate(uint256 _campaignId) public payable {
        // Store the campaign ID - might be useful if receive() logic were different
        lastAttackedCampaignId = _campaignId;
        // Call the target contract's donate function, forwarding the sent Ether (msg.value)
        crowdfundContract.donate{value: msg.value}(_campaignId);
        // No reentrant call attempt *within* this function itself.
    }

    /**
     * @notice Initiates a withdrawal call, assuming this contract is the campaign creator.
     * @dev This function calls the target's withdrawFunds. The reentrancy attempt
     * happens in the receive() function when Ether is sent back.
     * @param _campaignId The ID of the campaign to withdraw from.
     */
    function attackWithdraw(uint256 _campaignId) public {
        // Store the campaign ID so receive() knows which campaign to re-attack
        lastAttackedCampaignId = _campaignId;
        // Call the target contract's withdrawFunds function.
        // If this contract is the creator (as per the corrected test setup),
        // this call should proceed and send Ether back, triggering receive().
        crowdfundContract.withdrawFunds(_campaignId);
    }

    /**
     * @notice Fallback function triggered when this contract receives Ether.
     * @dev This is primarily expected to be called during the Ether transfer
     * step within Crowdfund.withdrawFunds(). It attempts the reentrant call.
     */
    receive() external payable {
        // Retrieve the ID of the campaign that triggered this Ether transfer
        uint256 campaignIdToAttack = lastAttackedCampaignId;

        // Only attempt reentrancy if we have a valid target campaign ID
        if (campaignIdToAttack > 0) {
            uint256 gas = gasleft(); // Check remaining gas
            emit ReentrancyAttemptTriggered(campaignIdToAttack, gas); // Emit event for test visibility/debug

            // Check for sufficient gas to prevent out-of-gas errors during the reentrant call attempt
            // Adjust the gas threshold (e.g., 50000) based on the complexity of withdrawFunds if needed.
            if (gas > 50000) {
                // --- The Reentrancy Attempt ---
                // Call the attackWithdraw function *again* internally.
                // This will, in turn, call crowdfundContract.withdrawFunds() again.
                // If the nonReentrant modifier in Crowdfund.withdrawFunds is working,
                // this second call should fail, causing the entire transaction to revert.
                this.attackWithdraw(campaignIdToAttack);
                // --- End Reentrancy Attempt ---
            }
        }
    }

    /**
     * @notice Helper function to check the Ether balance of this mock contract.
     * @return The current Ether balance in Wei.
     */
    function getBalance() public view returns (uint256) {
        return address(this).balance;
    }
}
