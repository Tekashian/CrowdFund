// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable.sol"; // Import Ownable

/**
 * @title Crowdfund Contract (Refactored v4.1 - With Commissions & Default Wallet)
 * @notice Manages crowdfunding campaigns with flexible fund handling and commission mechanisms.
 * Allows creators to initiate closure and provides donors a time window to reclaim funds via pull-payment.
 * @dev Inherits ReentrancyGuard and Ownable. Implements constant pull refunds for donors until finalization.
 * Uses Custom Errors for gas efficiency. Tracks individual donations. Includes commission for startup and charity campaigns.
 * Default commission wallet is hardcoded.
 */
contract Crowdfund is ReentrancyGuard, Ownable { // Inherit Ownable

    // --- Constants ---
    /**
     * @notice The duration (in seconds) donors have to reclaim funds after a creator initiates campaign closure.
     */
    uint256 public constant RECLAIM_PERIOD = 14 days;

    /**
     * @notice The default wallet address where commissions will be sent.
     */
    address public constant DEFAULT_COMMISSION_WALLET = 0x50a185CfCD1Ce799057EAa83586D1061F3C073c1;

    // --- State Variables ---

    /**
     * @notice Represents the type of a crowdfunding campaign, influencing commission rates.
     */
    enum CampaignType { Startup, Charity }

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
     * @param campaignType The type of the campaign (Startup or Charity).
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
        CampaignType campaignType; // New field for campaign type
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

    /**
     * @notice The wallet address where commissions will be sent.
     * @dev Initialized to DEFAULT_COMMISSION_WALLET, can be changed by the contract owner.
     */
    address public commissionWallet;

    /**
     * @notice Commission percentage for Startup campaigns (e.g., 200 for 2.00%).
     * @dev Stored as a value multiplied by 100 to handle two decimal places.
     */
    uint256 public startupCommissionPercentage; // e.g., 200 for 2.00%

    /**
     * @notice Commission percentage for Charity campaigns (e.g., 0 for 0.00%).
     * @dev Stored as a value multiplied by 100 to handle two decimal places.
     */
    uint256 public charityCommissionPercentage; // e.g., 0 for 0.00%

    // --- Events ---
    event CampaignCreated(uint256 indexed campaignId, address indexed creator, CampaignType campaignType, uint256 targetAmount, string dataCID, uint256 endTime, uint256 creationTimestamp);
    event DonationReceived(uint256 indexed campaignId, address indexed donor, uint256 amount, uint256 commissionAmount, uint256 timestamp);
    event FundsWithdrawn(uint256 indexed campaignId, address indexed creator, uint256 amount, uint256 commissionDeducted); // For successful completion withdrawal
    event CampaignClosingInitiated(uint256 indexed campaignId, address indexed initiator, uint256 reclaimDeadline); // Creator initiated closure
    event RefundClaimed(uint256 indexed campaignId, address indexed donor, uint256 amount); // Donor claimed refund
    event CampaignClosedByCreator(uint256 indexed campaignId, address indexed creator, uint256 amountWithdrawn, uint256 commissionDeducted); // Creator finalized closure
    event CommissionWalletChanged(address indexed newWallet);
    event StartupCommissionPercentageChanged(uint256 newPercentage);
    event CharityCommissionPercentageChanged(uint256 newPercentage);

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
    error CommissionTransferFailed();
    error AlreadyReclaimed(); // Donor already claimed refund
    error ReclaimPeriodActive(); // Tried to finalize closure too early
    error ReclaimPeriodOver(); // Tried to claim refund too late (after deadline in Closing state)
    error CannotCloseCompletedCampaign(); // Tried to initiateClosure on a Completed campaign
    error InvalidCommissionPercentage(); // Commission percentage is too high
    error CommissionWalletNotSet(); // Indicates commission wallet is address(0)

    // --- Constructor ---
    /**
     * @notice Initializes the contract, setting the initial owner and commission rates.
     * The commission wallet is set to DEFAULT_COMMISSION_WALLET.
     * @param _initialOwner The address of the contract owner.
     * @param _initialStartupCommissionPercentage The initial commission for startup campaigns (e.g., 200 for 2.00%).
     * @param _initialCharityCommissionPercentage The initial commission for charity campaigns (e.g., 0 for 0.00%).
     */
    constructor(
        address _initialOwner,
        uint256 _initialStartupCommissionPercentage,
        uint256 _initialCharityCommissionPercentage
    ) Ownable(_initialOwner) {
        if (DEFAULT_COMMISSION_WALLET == address(0)) revert CommissionWalletNotSet(); // Sanity check for the constant
        if (_initialStartupCommissionPercentage > 10000) revert InvalidCommissionPercentage(); // Max 100.00%
        if (_initialCharityCommissionPercentage > 10000) revert InvalidCommissionPercentage(); // Max 100.00%

        commissionWallet = DEFAULT_COMMISSION_WALLET;
        startupCommissionPercentage = _initialStartupCommissionPercentage;
        charityCommissionPercentage = _initialCharityCommissionPercentage;
    }


    // --- Functions ---

    /**
     * @notice Creates a new crowdfunding campaign.
     * @dev Initializes campaign state, sets status to Active.
     * @param _campaignType The type of campaign (Startup or Charity).
     * @param _targetAmount Funding goal in wei (> 0).
     * @param _dataCID Content identifier for details (not empty).
     * @param _endTime Unix timestamp for deadline (must be in future).
     */
    function createCampaign(
        CampaignType _campaignType,
        uint256 _targetAmount,
        string memory _dataCID,
        uint256 _endTime
    ) public {
        // Input validation
        if (_targetAmount == 0) revert TargetAmountMustBePositive();
        if (_endTime <= block.timestamp) revert EndTimeNotInFuture();
        if (bytes(_dataCID).length == 0) revert DataCIDCannotBeEmpty();
        if (commissionWallet == address(0)) revert CommissionWalletNotSet(); // Ensure commission wallet is effectively set

        // State updates
        uint256 campaignId = nextCampaignId++;
        Campaign storage campaign = campaigns[campaignId];
        campaign.creator = msg.sender;
        campaign.campaignType = _campaignType;
        campaign.targetAmount = _targetAmount;
        campaign.raisedAmount = 0;
        campaign.totalEverRaised = 0;
        campaign.dataCID = _dataCID;
        campaign.endTime = _endTime;
        campaign.status = Status.Active;
        campaign.creationTimestamp = block.timestamp;
        campaign.reclaimDeadline = 0; // Initialize to 0

        emit CampaignCreated(campaignId, msg.sender, _campaignType, _targetAmount, _dataCID, _endTime, block.timestamp);
    }

    /**
     * @notice Allows any user to donate Ether to an *active* campaign before its *original* deadline.
     * @dev Calculates and transfers commission from the donation amount.
     * Updates current balance (raisedAmount), cumulative total (totalEverRaised), and individual donation tracking.
     * Sets status to Completed if target is reached. Reentrancy protected.
     * @param _campaignId The ID of the campaign to donate to.
     */
    function donate(uint256 _campaignId) public payable nonReentrant {
        // Input validation & State checks
        if (!(_campaignId > 0 && _campaignId < nextCampaignId)) revert InvalidCampaignId();
        Campaign storage campaign = campaigns[_campaignId];

        if (campaign.status != Status.Active) revert CampaignNotActive();
        if (block.timestamp >= campaign.endTime) revert CampaignHasEnded();
        if (msg.value == 0) revert DonationAmountMustBePositive();
        if (commissionWallet == address(0)) revert CommissionWalletNotSet();

        // Calculate commission
        uint256 commissionRate = (campaign.campaignType == CampaignType.Startup) ? startupCommissionPercentage : charityCommissionPercentage;
        uint256 commissionAmount = (msg.value * commissionRate) / 10000; // 10000 because percentage is stored as value * 100 (e.g., 2.00% is 200)
        uint256 amountToCampaign = msg.value - commissionAmount;

        // Effects
        campaign.raisedAmount += amountToCampaign; // Only amount after commission goes to campaign balance
        campaign.totalEverRaised += msg.value; // Track full donation for progress
        donations[_campaignId][msg.sender] += amountToCampaign; // Track net donation for refund purposes

        emit DonationReceived(_campaignId, msg.sender, msg.value, commissionAmount, block.timestamp);

        // Interaction: Transfer commission
        if (commissionAmount > 0) {
            (bool success, ) = commissionWallet.call{value: commissionAmount}("");
            if (!success) {
                // If commission transfer fails, revert the donation.
                // State changes above will be rolled back by the revert.
                revert CommissionTransferFailed();
            }
        }

        // Check if target is reached
        if (campaign.raisedAmount >= campaign.targetAmount && campaign.targetAmount > 0) {
            campaign.status = Status.Completed;
        }
    }

    /**
     * @notice Allows a donor to reclaim their *net contributed amount* (after commission) if the campaign is Active or Closing (before deadline).
     * @dev Cannot reclaim if already reclaimed, if campaign is in a final state (Completed, Withdrawn, ClosedByCreator),
     * or after the reclaim deadline has passed in the Closing state. Reentrancy protected.
     * Commission is NOT refunded to the donor as it was already paid.
     * @param _campaignId The ID of the campaign to reclaim funds from.
     */
    function claimRefund(uint256 _campaignId) public nonReentrant {
        if (!(_campaignId > 0 && _campaignId < nextCampaignId)) revert InvalidCampaignId();
        Campaign storage campaign = campaigns[_campaignId];
        Status currentStatus = campaign.status;

        if (currentStatus != Status.Active && currentStatus != Status.Closing) {
            revert CampaignNotActiveOrClosing();
        }
        if (currentStatus == Status.Closing && block.timestamp >= campaign.reclaimDeadline) {
            revert ReclaimPeriodOver();
        }

        uint256 netDonationAmount = donations[_campaignId][msg.sender]; // This is the amount AFTER commission
        if (netDonationAmount == 0) revert NoDonationToClaim();
        if (hasReclaimed[_campaignId][msg.sender]) revert AlreadyReclaimed();

        // Effects: Mark as reclaimed, zero donation record, decrease balance
        hasReclaimed[_campaignId][msg.sender] = true;
        donations[_campaignId][msg.sender] = 0;
        campaign.raisedAmount -= netDonationAmount; // Decrease by the net amount

        // Interaction: Transfer funds
        (bool success, ) = msg.sender.call{value: netDonationAmount}("");
        if (!success) {
            // Revert state changes if transfer fails
            hasReclaimed[_campaignId][msg.sender] = false;
            donations[_campaignId][msg.sender] = netDonationAmount;
            campaign.raisedAmount += netDonationAmount;
            revert FundTransferFailed();
        }

        emit RefundClaimed(_campaignId, msg.sender, netDonationAmount);
    }

    /**
     * @notice Allows the campaign creator to initiate the early closure process for an *Active* campaign.
     * @dev Sets the status to Closing and defines the deadline for donor refunds based on RECLAIM_PERIOD.
     * Reentrancy protected. Can be called even after the original endTime if the campaign remained Active (target not met).
     * @param _campaignId The ID of the Active campaign to initiate closure for.
     */
    function initiateClosure(uint256 _campaignId) public nonReentrant {
        if (!(_campaignId > 0 && _campaignId < nextCampaignId)) revert InvalidCampaignId();
        Campaign storage campaign = campaigns[_campaignId];

        if (msg.sender != campaign.creator) revert NotCampaignCreator();
        if (campaign.status == Status.Completed) revert CannotCloseCompletedCampaign();
        if (campaign.status != Status.Active) revert CampaignNotActive();

        campaign.status = Status.Closing;
        campaign.reclaimDeadline = block.timestamp + RECLAIM_PERIOD;

        emit CampaignClosingInitiated(_campaignId, msg.sender, campaign.reclaimDeadline);
    }

    /**
     * @notice Allows the creator to withdraw remaining funds after initiating closure and waiting for the reclaim period to end.
     * @dev Can only be called after the reclaim deadline has passed for a 'Closing' campaign.
     * The commission has already been taken during donations, so no further commission is deducted here.
     * Transfers the *remaining* balance to the creator and sets status to ClosedByCreator. Reentrancy protected.
     * @param _campaignId The ID of the campaign in the Closing state.
     */
    function finalizeClosureAndWithdraw(uint256 _campaignId) public nonReentrant {
        if (!(_campaignId > 0 && _campaignId < nextCampaignId)) revert InvalidCampaignId();
        Campaign storage campaign = campaigns[_campaignId];

        if (msg.sender != campaign.creator) revert NotCampaignCreator();
        if (campaign.status != Status.Closing) revert CampaignNotClosing();
        if (block.timestamp < campaign.reclaimDeadline) revert ReclaimPeriodActive();

        uint256 amountToWithdraw = campaign.raisedAmount; // This is the net amount after commissions and any refunds

        // Effects before interaction
        campaign.raisedAmount = 0;
        campaign.status = Status.ClosedByCreator;

        // Interaction
        if (amountToWithdraw > 0) {
            (bool success, ) = msg.sender.call{value: amountToWithdraw}("");
            if (!success) {
                campaign.raisedAmount = amountToWithdraw;
                campaign.status = Status.Closing;
                revert FundTransferFailed();
            }
        }
        // No commission to deduct here, as it was taken per donation.
        emit CampaignClosedByCreator(_campaignId, msg.sender, amountToWithdraw, 0);
    }

    /**
     * @notice Allows the campaign creator to withdraw the raised funds ONLY after a campaign is successfully *Completed*.
     * @dev The commission has already been taken during donations.
     * Standard withdrawal for successful campaigns. Transfers entire (net) balance. Reentrancy protected.
     * @param _campaignId The ID of the completed campaign.
     */
    function withdrawFunds(uint256 _campaignId) public nonReentrant {
        if (!(_campaignId > 0 && _campaignId < nextCampaignId)) revert InvalidCampaignId();
        Campaign storage campaign = campaigns[_campaignId];

        if (msg.sender != campaign.creator) revert NotCampaignCreator();
        if (campaign.status != Status.Completed) revert CampaignNotCompleted();

        uint256 amountToWithdraw = campaign.raisedAmount; // This is the net amount after commissions

        // Effects before interaction
        campaign.raisedAmount = 0;
        campaign.status = Status.Withdrawn;

        // Interaction
        if (amountToWithdraw > 0) { // Target reached, so raisedAmount (net) should be > 0
            (bool success, ) = msg.sender.call{value: amountToWithdraw}("");
            if (!success) {
                campaign.raisedAmount = amountToWithdraw;
                campaign.status = Status.Completed;
                revert FundTransferFailed();
            }
        }
        // No commission to deduct here, as it was taken per donation.
        emit FundsWithdrawn(_campaignId, msg.sender, amountToWithdraw, 0);
    }

    // --- Commission Management Functions (Owner Only) ---

    /**
     * @notice Sets the wallet address for collecting commissions.
     * @dev Only callable by the contract owner.
     * @param _newCommissionWallet The new address for the commission wallet.
     */
    function setCommissionWallet(address _newCommissionWallet) public onlyOwner {
        if (_newCommissionWallet == address(0)) revert CommissionWalletNotSet(); // Cannot set to zero address
        commissionWallet = _newCommissionWallet;
        emit CommissionWalletChanged(_newCommissionWallet);
    }

    /**
     * @notice Sets the commission percentage for Startup campaigns.
     * @dev Only callable by the contract owner. Percentage is scaled by 100 (e.g., 250 for 2.50%). Max 100.00% (10000).
     * @param _newPercentage The new commission percentage for startup campaigns.
     */
    function setStartupCommissionPercentage(uint256 _newPercentage) public onlyOwner {
        if (_newPercentage > 10000) revert InvalidCommissionPercentage(); // Max 100.00%
        startupCommissionPercentage = _newPercentage;
        emit StartupCommissionPercentageChanged(_newPercentage);
    }

    /**
     * @notice Sets the commission percentage for Charity campaigns.
     * @dev Only callable by the contract owner. Percentage is scaled by 100 (e.g., 50 for 0.50%). Max 100.00% (10000).
     * @param _newPercentage The new commission percentage for charity campaigns.
     */
    function setCharityCommissionPercentage(uint256 _newPercentage) public onlyOwner {
        if (_newPercentage > 10000) revert InvalidCommissionPercentage(); // Max 100.00%
        charityCommissionPercentage = _newPercentage;
        emit CharityCommissionPercentageChanged(_newPercentage);
    }

    // --- View Functions ---

    /**
     * @notice Gets the details of a specific campaign.
     * @param _campaignId The ID of the campaign.
     * @return Campaign details.
     */
    function getCampaign(uint256 _campaignId) external view returns (Campaign memory) {
        if (!(_campaignId > 0 && _campaignId < nextCampaignId)) revert InvalidCampaignId();
        if (campaigns[_campaignId].creationTimestamp == 0) revert InvalidCampaignId(); // Ensure campaign exists
        return campaigns[_campaignId];
    }

    /**
     * @notice Gets the creator address for a specific campaign.
     * @dev Provides read-only access. Reverts if campaign ID is invalid.
     * @param _campaignId The ID of the campaign.
     * @return creatorAddress The address of the campaign creator.
     */
    function getCampaignCreator(uint256 _campaignId) external view returns (address creatorAddress) {
        if (!(_campaignId > 0 && _campaignId < nextCampaignId)) revert InvalidCampaignId();
        if (campaigns[_campaignId].creationTimestamp == 0) revert InvalidCampaignId();
        creatorAddress = campaigns[_campaignId].creator;
    }

    /**
     * @notice Gets the net donation amount for a specific donor in a campaign.
     * @param _campaignId The ID of the campaign.
     * @param _donor The address of the donor.
     * @return The net amount donated by the donor after commission.
     */
    function getDonationAmount(uint256 _campaignId, address _donor) external view returns (uint256) {
        if (!(_campaignId > 0 && _campaignId < nextCampaignId)) revert InvalidCampaignId();
        // No need to check campaign existence here as mapping defaults to 0 if donor/campaign invalid
        return donations[_campaignId][_donor];
    }
}