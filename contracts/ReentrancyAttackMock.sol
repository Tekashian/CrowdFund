// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import "./Crowdfund.sol"; // Upewnij się, że ta ścieżka jest poprawna

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
    }

    /**
     * @notice Allows an external account to instruct this mock contract to create a campaign.
     * @dev This contract's address will be recorded as the 'creator' in the Crowdfund contract.
     * Emits MockCampaignCreated event with the new campaign ID upon successful creation.
     * @param _campaignType The type of the campaign (Startup or Charity).
     * @param _targetAmount Target fundraising amount for the campaign.
     * @param _dataCID Identifier (e.g., IPFS hash) for campaign details.
     * @param _endTime Unix timestamp for the campaign's end.
     */
    function createCampaignOnBehalf(
        Crowdfund.CampaignType _campaignType,
        uint256 _targetAmount,
        string memory _dataCID,
        uint256 _endTime
    ) public {
        crowdfundContract.createCampaign(_campaignType, _targetAmount, _dataCID, _endTime);

        uint256 currentNextId = crowdfundContract.nextCampaignId();
        if (currentNextId > 1) {
            emit MockCampaignCreated(currentNextId - 1);
        }
    }

    /**
     * @notice Initiates a donation call to the target Crowdfund contract.
     * @param _campaignId The ID of the campaign to donate to.
     */
    function attackDonate(uint256 _campaignId) public payable {
        lastAttackedCampaignId = _campaignId;
        crowdfundContract.donate{value: msg.value}(_campaignId);
    }

    /**
     * @notice Initiates a withdrawal call, assuming this contract is the campaign creator.
     * @param _campaignId The ID of the campaign to withdraw from.
     */
    function attackWithdraw(uint256 _campaignId) public {
        lastAttackedCampaignId = _campaignId;
        crowdfundContract.withdrawFunds(_campaignId);
    }

    /**
     * @notice Fallback function triggered when this contract receives Ether.
     * @dev This is primarily expected to be called during the Ether transfer
     * step within Crowdfund.withdrawFunds(). It attempts the reentrant call.
     */
    receive() external payable {
        uint256 campaignIdToAttack = lastAttackedCampaignId;

        if (campaignIdToAttack > 0) { // Upewnij się, że mamy kontekst kampanii
            uint256 gas = gasleft();
            emit ReentrancyAttemptTriggered(campaignIdToAttack, gas);

            // Sprawdź, czy jest wystarczająco gazu na próbę wykonania wywołania reentrancyjnego.
            // Wartość 60000 jest przykładowa, może wymagać dostosowania.
            if (gas > 60000) {
                this.attackWithdraw(campaignIdToAttack); // Bezpośrednia próba reentrancyjnego ataku
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