// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title Crowdfund Contract (Refactored v3 - Closure Model)
 * @notice Manages crowdfunding campaigns with flexible fund handling for uncompleted campaigns.
 * Allows creators to initiate closure and provides donors a time window to reclaim funds via pull-payment.
 * @dev Inherits ReentrancyGuard. Implements constant pull refunds for donors until finalization.
 * Uses Custom Errors for gas efficiency. Tracks individual donations.
 */
contract Crowdfund is ReentrancyGuard {

    // --- Constants ---
    /**
     * @notice The duration (in seconds) donors have to reclaim funds after a creator initiates campaign closure.
     */
    uint256 public constant RECLAIM_PERIOD = 14 days;

    // --- State Variables ---

    /**
     * @notice Represents the possible states of a crowdfunding campaign.
     * @dev Active: Accepting donations, refunds allowed.
     * Completed: Target reached, standard creator withdrawal allowed, refunds blocked.
     * Closing: Creator initiated early closure, reclaim window active for donors, new donations blocked.
     * Withdrawn: Funds successfully withdrawn by creator after campaign *completion*. Final state.
     * ClosedByCreator: Campaign closed by creator after reclaim window, remaining funds withdrawn by creator. Final state.
     */
    enum Status { Active, Completed, Closing, Withdrawn, ClosedByCreator }

    /**
     * @notice Stores all relevant information about a single crowdfunding campaign.
     * @param creator The address of the user who created the campaign.
     * @param targetAmount The minimum amount of Ether (in wei) required for the campaign to be successful.
     * @param raisedAmount The current balance of Ether (in wei) held by the contract for this campaign. Decreases on refunds/withdrawals.
     * @param totalEverRaised The total cumulative amount of Ether (in wei) ever donated to this campaign. Used for UI/progress tracking.
     * @param dataCID A content identifier (e.g., IPFS CID) linking to campaign details.
     * @param endTime The Unix timestamp marking the originally planned deadline for donations.
     * @param status The current status of the campaign.
     * @param creationTimestamp The Unix timestamp when the campaign was created.
     * @param reclaimDeadline The Unix timestamp marking the end of the donor reclaim window (only set if status is Closing).
     */
    struct Campaign {
        address creator;
        uint256 targetAmount;
        uint256 raisedAmount; // Current balance
        uint256 totalEverRaised; // Cumulative donations
        string dataCID;
        uint256 endTime;
        Status status;
        uint256 creationTimestamp;
        uint256 reclaimDeadline;
    }

    /**
     * @notice Maps campaign IDs to their corresponding Campaign struct.
     */
    mapping(uint256 => Campaign) public campaigns;

    /**
     * @notice Maps campaign ID and donor address to the current amount donated by that donor (can be zeroed after refund).
     */
    mapping(uint256 => mapping(address => uint256)) public donations;

    /**
     * @notice Maps campaign ID and donor address to whether the donor has already reclaimed their funds for that campaign.
     */
    mapping(uint256 => mapping(address => bool)) public hasReclaimed;

    /**
     * @notice A counter to generate unique campaign IDs. Starts at 1.
     */
    uint256 public nextCampaignId = 1;

    // --- Events ---
    event CampaignCreated(uint256 indexed campaignId, address indexed creator, uint256 targetAmount, string dataCID, uint256 endTime, uint256 creationTimestamp);
    event DonationReceived(uint256 indexed campaignId, address indexed donor, uint256 amount, uint256 timestamp);
    event FundsWithdrawn(uint256 indexed campaignId, address indexed creator, uint256 amount); // For successful completion withdrawal
    event CampaignClosingInitiated(uint256 indexed campaignId, address indexed initiator, uint256 reclaimDeadline); // Creator initiated closure
    event RefundClaimed(uint256 indexed campaignId, address indexed donor, uint256 amount); // Donor claimed refund
    event CampaignClosedByCreator(uint256 indexed campaignId, address indexed creator, uint256 amountWithdrawn); // Creator finalized closure

    // --- Custom Errors ---
    error TargetAmountMustBePositive();
    error EndTimeNotInFuture();
    error DataCIDCannotBeEmpty();
    error InvalidCampaignId();
    error CampaignNotActive(); // Used when action requires strictly Active state (e.g., donate, initiateClosure on non-completed)
    error CampaignNotActiveOrClosing(); // Used when action allowed in Active or Closing (e.g., claimRefund before deadline)
    error CampaignNotClosing(); // Used when action requires strictly Closing state (e.g., finalizeClosure)
    error CampaignNotCompleted(); // Used for standard withdrawal
    error CampaignHasEnded(); // Original deadline passed (for donations)
    error DonationAmountMustBePositive();
    error NotCampaignCreator();
    error NoDonationToClaim(); // Used in claimRefund if donation amount is 0 for the caller
    error FundTransferFailed();
    error AlreadyReclaimed(); // Donor already claimed refund
    error ReclaimPeriodActive(); // Tried to finalize closure too early
    error ReclaimPeriodOver(); // Tried to claim refund too late (after deadline in Closing state)
    error CannotCloseCompletedCampaign(); // Tried to initiateClosure on a Completed campaign

    // --- Functions ---

    /**
     * @notice Creates a new crowdfunding campaign.
     * @dev Initializes campaign state, sets status to Active.
     * @param _targetAmount Funding goal in wei (> 0).
     * @param _dataCID Content identifier for details (not empty).
     * @param _endTime Unix timestamp for deadline (must be in future).
     */
    function createCampaign(
        uint256 _targetAmount,
        string memory _dataCID,
        uint256 _endTime
    ) public {
        // Input validation
        if (_targetAmount == 0) revert TargetAmountMustBePositive();
        if (_endTime <= block.timestamp) revert EndTimeNotInFuture();
        if (bytes(_dataCID).length == 0) revert DataCIDCannotBeEmpty();

        // State updates
        uint256 campaignId = nextCampaignId++;
        Campaign storage campaign = campaigns[campaignId];
        campaign.creator = msg.sender;
        campaign.targetAmount = _targetAmount;
        campaign.raisedAmount = 0;
        campaign.totalEverRaised = 0;
        campaign.dataCID = _dataCID;
        campaign.endTime = _endTime;
        campaign.status = Status.Active;
        campaign.creationTimestamp = block.timestamp;
        campaign.reclaimDeadline = 0; // Initialize to 0

        emit CampaignCreated(campaignId, msg.sender, _targetAmount, _dataCID, _endTime, block.timestamp);
    }

    /**
     * @notice Allows any user to donate Ether to an *active* campaign before its *original* deadline.
     * @dev Updates current balance (raisedAmount), cumulative total (totalEverRaised), and individual donation tracking.
     * Sets status to Completed if target is reached. Reentrancy protected.
     * @param _campaignId The ID of the campaign to donate to.
     */
    function donate(uint256 _campaignId) public payable nonReentrant {
        // Input validation & State checks
        if (!(_campaignId > 0 && _campaignId < nextCampaignId)) revert InvalidCampaignId();
        Campaign storage campaign = campaigns[_campaignId];

        // Ensure donations only happen in Active state
        if (campaign.status != Status.Active) revert CampaignNotActive();
        // Check against original deadline
        if (block.timestamp >= campaign.endTime) revert CampaignHasEnded();
        if (msg.value == 0) revert DonationAmountMustBePositive();

        // Effects
        campaign.raisedAmount += msg.value;
        campaign.totalEverRaised += msg.value;
        // Track individual donation (adds to existing donation if user donates again)
        donations[_campaignId][msg.sender] += msg.value;

        emit DonationReceived(_campaignId, msg.sender, msg.value, block.timestamp);

        // Check if target is reached - transition to Completed
        // Raised amount check is technically redundant if targetAmount > 0, but safe to keep.
        if (campaign.raisedAmount >= campaign.targetAmount && campaign.targetAmount > 0) {
            campaign.status = Status.Completed;
        }
    }

    /**
     * @notice Allows a donor to reclaim their *entire* contributed amount if the campaign is Active or Closing (before deadline).
     * @dev Cannot reclaim if already reclaimed, if campaign is in a final state (Completed, Withdrawn, ClosedByCreator),
     * or after the reclaim deadline has passed in the Closing state. Reentrancy protected.
     * @param _campaignId The ID of the campaign to reclaim funds from.
     */
    function claimRefund(uint256 _campaignId) public nonReentrant {
        // Input validation & State checks
        if (!(_campaignId > 0 && _campaignId < nextCampaignId)) revert InvalidCampaignId();
        Campaign storage campaign = campaigns[_campaignId];
        Status currentStatus = campaign.status;

        // Check if campaign status allows refunds (Active or Closing)
        if (currentStatus != Status.Active && currentStatus != Status.Closing) {
             revert CampaignNotActiveOrClosing();
        }

        // If campaign is Closing, check if reclaim window is still active
        if (currentStatus == Status.Closing && block.timestamp >= campaign.reclaimDeadline) {
            revert ReclaimPeriodOver();
        }

        uint256 donationAmount = donations[_campaignId][msg.sender];
        if (donationAmount == 0) revert NoDonationToClaim();
        if (hasReclaimed[_campaignId][msg.sender]) revert AlreadyReclaimed();

        // Effects: Mark as reclaimed, zero donation record, decrease balance
        hasReclaimed[_campaignId][msg.sender] = true;
        donations[_campaignId][msg.sender] = 0;
        campaign.raisedAmount -= donationAmount;

        // Interaction: Transfer funds
        (bool success, ) = msg.sender.call{value: donationAmount}("");
        if (!success) {
            // Revert state changes if transfer fails to prevent state corruption
            hasReclaimed[_campaignId][msg.sender] = false;
            donations[_campaignId][msg.sender] = donationAmount; // Restore donation amount
            campaign.raisedAmount += donationAmount; // Restore balance
            revert FundTransferFailed();
        }

        emit RefundClaimed(_campaignId, msg.sender, donationAmount);
    }

    /**
     * @notice Allows the campaign creator to initiate the early closure process for an *Active* campaign.
     * @dev Sets the status to Closing and defines the deadline for donor refunds based on RECLAIM_PERIOD.
     * Reentrancy protected. Can be called even after the original endTime if the campaign remained Active (target not met).
     * @param _campaignId The ID of the Active campaign to initiate closure for.
     */
    function initiateClosure(uint256 _campaignId) public nonReentrant {
        // Input validation & State checks
        if (!(_campaignId > 0 && _campaignId < nextCampaignId)) revert InvalidCampaignId();
        Campaign storage campaign = campaigns[_campaignId];

        if (msg.sender != campaign.creator) revert NotCampaignCreator();
        // Can only initiate closure for Active campaigns that haven't completed.
        if (campaign.status == Status.Completed) revert CannotCloseCompletedCampaign();
        if (campaign.status != Status.Active) revert CampaignNotActive(); // Handles Closing, Withdrawn, ClosedByCreator states

        // Effects
        campaign.status = Status.Closing;
        campaign.reclaimDeadline = block.timestamp + RECLAIM_PERIOD;

        emit CampaignClosingInitiated(_campaignId, msg.sender, campaign.reclaimDeadline);
    }

    /**
     * @notice Allows the creator to withdraw remaining funds after initiating closure and waiting for the reclaim period to end.
     * @dev Can only be called after the reclaim deadline has passed for a 'Closing' campaign.
     * Transfers the *remaining* balance to the creator and sets status to ClosedByCreator. Reentrancy protected.
     * @param _campaignId The ID of the campaign in the Closing state.
     */
    function finalizeClosureAndWithdraw(uint256 _campaignId) public nonReentrant {
        // Input validation & State checks
        if (!(_campaignId > 0 && _campaignId < nextCampaignId)) revert InvalidCampaignId();
        Campaign storage campaign = campaigns[_campaignId];

        if (msg.sender != campaign.creator) revert NotCampaignCreator();
        if (campaign.status != Status.Closing) revert CampaignNotClosing();
        if (block.timestamp < campaign.reclaimDeadline) revert ReclaimPeriodActive();

        uint256 amountToWithdraw = campaign.raisedAmount; // Withdraw remaining balance

        // Effects before interaction
        campaign.raisedAmount = 0;
        campaign.status = Status.ClosedByCreator; // Final status for this path

        // Interaction
        if (amountToWithdraw > 0) {
            (bool success, ) = msg.sender.call{value: amountToWithdraw}("");
            if (!success) {
                // Revert state changes if transfer fails
                campaign.raisedAmount = amountToWithdraw; // Restore balance
                campaign.status = Status.Closing; // Revert status
                revert FundTransferFailed();
            }
        }

        emit CampaignClosedByCreator(_campaignId, msg.sender, amountToWithdraw);
    }

    /**
     * @notice Allows the campaign creator to withdraw the raised funds ONLY after a campaign is successfully *Completed*.
     * @dev Standard withdrawal for successful campaigns. Transfers entire balance. Reentrancy protected.
     * @param _campaignId The ID of the completed campaign.
     */
    function withdrawFunds(uint256 _campaignId) public nonReentrant {
        // Input validation & State checks
        if (!(_campaignId > 0 && _campaignId < nextCampaignId)) revert InvalidCampaignId();
        Campaign storage campaign = campaigns[_campaignId];

        if (msg.sender != campaign.creator) revert NotCampaignCreator();
        // Strict check for Completed status
        if (campaign.status != Status.Completed) revert CampaignNotCompleted();

        uint256 amount = campaign.raisedAmount; // Amount should be >= targetAmount

        // Effects before interaction
        campaign.raisedAmount = 0;
        campaign.status = Status.Withdrawn; // Standard final status for successful campaigns

        // Interaction
        // No need to check amount > 0, as Completed status guarantees raisedAmount >= targetAmount > 0
        (bool success, ) = msg.sender.call{value: amount}("");
        if (!success) {
             // Revert state changes if transfer fails
            campaign.raisedAmount = amount; // Restore balance
            campaign.status = Status.Completed; // Revert status
            revert FundTransferFailed();
        }

        emit FundsWithdrawn(_campaignId, msg.sender, amount);
    }

    /**
     * @notice Gets the creator address for a specific campaign.
     * @dev Provides read-only access. Reverts if campaign ID is invalid.
     * @param _campaignId The ID of the campaign.
     * @return creatorAddress The address of the campaign creator.
     */
    function getCampaignCreator(uint256 _campaignId) external view returns (address creatorAddress) {
        if (!(_campaignId > 0 && _campaignId < nextCampaignId)) revert InvalidCampaignId();
        // Check if campaign actually exists by checking timestamp, prevents reading default values for invalid IDs < nextCampaignId
        if (campaigns[_campaignId].creationTimestamp == 0) revert InvalidCampaignId();
        creatorAddress = campaigns[_campaignId].creator;
    }

    // Function cancelCampaign was removed. Use initiateClosure instead for early ending.
}
