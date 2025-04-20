// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title Crowdfund Contract
 * @notice Manages crowdfunding campaigns, allowing users to create, donate to,
 * and withdraw funds from campaigns upon successful completion.
 * @dev Inherits ReentrancyGuard to prevent reentrancy attacks on payable functions. Uses Custom Errors for gas efficiency.
 */
contract Crowdfund is ReentrancyGuard {
    /**
     * @notice Represents the possible states of a crowdfunding campaign.
     * @dev Active: Campaign is accepting donations.
     * Cancelled: Campaign was cancelled by the creator before completion.
     * Completed: Campaign reached its target amount.
     * Withdrawn: Funds for a completed campaign have been withdrawn by the creator.
     */
    enum Status { Active, Cancelled, Completed, Withdrawn }

    /**
     * @notice Stores all relevant information about a single crowdfunding campaign.
     * @param creator The address of the user who created the campaign.
     * @param targetAmount The minimum amount of Ether (in wei) required for the campaign to be successful.
     * @param raisedAmount The total amount of Ether (in wei) donated to the campaign so far.
     * @param dataCID A content identifier (e.g., IPFS CID) linking to campaign details (metadata, description, images).
     * @param endTime The Unix timestamp marking the deadline for donations.
     * @param status The current status of the campaign (Active, Cancelled, Completed, Withdrawn).
     * @param creationTimestamp The Unix timestamp when the campaign was created.
     */
    struct Campaign {
        address creator;
        uint256 targetAmount;
        uint256 raisedAmount;
        string dataCID;
        uint256 endTime;
        Status status;
        uint256 creationTimestamp;
    }

    // --- State Variables ---
    /**
     * @notice Maps campaign IDs to their corresponding Campaign struct. Public for easy read access.
     */
    mapping(uint256 => Campaign) public campaigns;
    /**
     * @notice A counter to generate unique campaign IDs. Starts at 1. Public for transparency.
     */
    uint256 public nextCampaignId = 1;

    // --- Events ---
    /**
     * @notice Emitted when a new campaign is successfully created.
     * @param campaignId The unique ID assigned to the new campaign.
     * @param creator The address of the campaign creator.
     * @param targetAmount The funding goal of the campaign (in wei).
     * @param dataCID The content identifier for campaign details.
     * @param endTime The donation deadline timestamp.
     * @param creationTimestamp The timestamp of campaign creation.
     */
    event CampaignCreated(uint256 campaignId, address indexed creator, uint256 targetAmount, string dataCID, uint256 endTime, uint256 creationTimestamp);
    /**
     * @notice Emitted when a donation is successfully received for a campaign.
     * @param campaignId The ID of the campaign receiving the donation.
     * @param donor The address of the donor.
     * @param amount The amount of Ether donated (in wei).
     * @param timestamp The timestamp of the donation.
     */
    event DonationReceived(uint256 indexed campaignId, address indexed donor, uint256 amount, uint256 timestamp);
    /**
     * @notice Emitted when the creator successfully withdraws funds from a completed campaign.
     * @param campaignId The ID of the campaign from which funds were withdrawn.
     * @param creator The address of the creator withdrawing the funds.
     * @param amount The amount of Ether withdrawn (in wei).
     */
    event FundsWithdrawn(uint256 indexed campaignId, address indexed creator, uint256 amount);
    /**
     * @notice Emitted when a campaign is cancelled by its creator.
     * @param campaignId The ID of the cancelled campaign.
     * @param creator The address of the creator who cancelled the campaign.
     * @param timestamp The timestamp of the cancellation.
     */
    event CampaignCancelled(uint256 indexed campaignId, address indexed creator, uint256 timestamp);

    // --- Custom Errors ---
    error TargetAmountMustBePositive();
    error EndTimeNotInFuture();
    error DataCIDCannotBeEmpty();
    error InvalidCampaignId();
    error CampaignNotActive();
    error CampaignHasEnded();
    error DonationAmountMustBePositive();
    error NotCampaignCreator();
    error CampaignNotCompleted();
    error NoFundsToWithdraw();
    error FundTransferFailed();
    error CannotCancelAfterEndTime();

    // --- Functions ---

    /**
     * @notice Creates a new crowdfunding campaign.
     * @dev Assigns a unique ID, stores campaign details, sets status to Active, and emits CampaignCreated event.
     * Reverts with TargetAmountMustBePositive, EndTimeNotInFuture, or DataCIDCannotBeEmpty on invalid input.
     * @param _targetAmount The funding goal in wei. Must be greater than 0.
     * @param _dataCID The content identifier (e.g., IPFS CID) for campaign details. Cannot be empty.
     * @param _endTime The Unix timestamp for the campaign deadline. Must be in the future.
     */
    function createCampaign(
        uint256 _targetAmount,
        string memory _dataCID,
        uint256 _endTime
    ) public {
        if (_targetAmount == 0) revert TargetAmountMustBePositive();
        if (_endTime <= block.timestamp) revert EndTimeNotInFuture();
        if (bytes(_dataCID).length == 0) revert DataCIDCannotBeEmpty();

        uint256 campaignId = nextCampaignId++;
        Campaign storage campaign = campaigns[campaignId];
        campaign.creator = msg.sender;
        campaign.targetAmount = _targetAmount;
        // campaign.raisedAmount is initialized to 0 by default
        campaign.dataCID = _dataCID;
        campaign.endTime = _endTime;
        campaign.status = Status.Active;
        campaign.creationTimestamp = block.timestamp;

        emit CampaignCreated(campaignId, msg.sender, _targetAmount, _dataCID, _endTime, block.timestamp);
    }

    /**
     * @notice Allows any user to donate Ether to an active campaign before its deadline.
     * @dev Updates the campaign's raised amount. If the target is met or exceeded, sets campaign status to Completed.
     * Emits DonationReceived event. Protected against reentrancy attacks.
     * Reverts with InvalidCampaignId, CampaignNotActive, CampaignHasEnded, or DonationAmountMustBePositive on invalid conditions.
     * @param _campaignId The ID of the campaign to donate to.
     */
    function donate(uint256 _campaignId) public payable nonReentrant {
        if (!(_campaignId > 0 && _campaignId < nextCampaignId)) revert InvalidCampaignId();
        Campaign storage campaign = campaigns[_campaignId];
        if (campaign.status != Status.Active) revert CampaignNotActive();
        if (block.timestamp >= campaign.endTime) revert CampaignHasEnded();
        if (msg.value == 0) revert DonationAmountMustBePositive();

        campaign.raisedAmount += msg.value;

        emit DonationReceived(_campaignId, msg.sender, msg.value, block.timestamp);

        // Check if target is reached *after* adding the donation
        if (campaign.raisedAmount >= campaign.targetAmount) {
            campaign.status = Status.Completed;
        }
    }

    /**
     * @notice Allows the campaign creator to withdraw the raised funds after a campaign is successfully completed.
     * @dev Transfers the entire raised amount to the creator's address (`msg.sender`).
     * Sets the campaign status to Withdrawn and raised amount to 0 to prevent multiple withdrawals.
     * Emits FundsWithdrawn event. Protected against reentrancy attacks.
     * Reverts with InvalidCampaignId, NotCampaignCreator, CampaignNotCompleted, NoFundsToWithdraw, or FundTransferFailed.
     * @param _campaignId The ID of the completed campaign.
     */
    function withdrawFunds(uint256 _campaignId) public nonReentrant {
        if (!(_campaignId > 0 && _campaignId < nextCampaignId)) revert InvalidCampaignId();
        Campaign storage campaign = campaigns[_campaignId];
        if (msg.sender != campaign.creator) revert NotCampaignCreator();
        if (campaign.status != Status.Completed) revert CampaignNotCompleted();
        if (campaign.raisedAmount == 0) revert NoFundsToWithdraw(); // Although status check implies raisedAmount >= targetAmount

        uint256 amount = campaign.raisedAmount;
        // Set state before external call (Checks-Effects-Interactions pattern)
        campaign.raisedAmount = 0;
        campaign.status = Status.Withdrawn;

        // Send funds to the creator (msg.sender)
        (bool success, ) = msg.sender.call{value: amount}("");
        if (!success) revert FundTransferFailed(); // Revert if transfer fails

        emit FundsWithdrawn(_campaignId, msg.sender, amount);
    }

    /**
     * @notice Allows the campaign creator to cancel an active campaign before its end time.
     * @dev Sets the campaign status to Cancelled. Does not handle refunds (assumed handled off-chain or via separate mechanism).
     * Emits CampaignCancelled event.
     * Reverts with InvalidCampaignId, NotCampaignCreator, CampaignNotActive, or CannotCancelAfterEndTime.
     * @param _campaignId The ID of the campaign to cancel.
     */
    function cancelCampaign(uint256 _campaignId) public {
        if (!(_campaignId > 0 && _campaignId < nextCampaignId)) revert InvalidCampaignId();
        Campaign storage campaign = campaigns[_campaignId];
        if (msg.sender != campaign.creator) revert NotCampaignCreator();
        if (campaign.status != Status.Active) revert CampaignNotActive();
        if (block.timestamp >= campaign.endTime) revert CannotCancelAfterEndTime();

        campaign.status = Status.Cancelled;
        emit CampaignCancelled(_campaignId, msg.sender, block.timestamp);
        // Note: No refund logic implemented here. Assumes donors claim refunds elsewhere if needed.
    }

    /**
     * @notice Gets the creator address for a specific campaign.
     * @dev Provides read-only access to the campaign creator's address. Includes check for valid campaign ID.
     * Reverts with InvalidCampaignId if the ID is not valid.
     * @param _campaignId The ID of the campaign.
     * @return creatorAddress The address of the campaign creator.
     */
    function getCampaignCreator(uint256 _campaignId) external view returns (address creatorAddress) {
        if (!(_campaignId > 0 && _campaignId < nextCampaignId)) revert InvalidCampaignId();
        creatorAddress = campaigns[_campaignId].creator;
    }
}
