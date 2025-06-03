// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";

/**
 * @title Crowdfund Contract (Refactored v5.5.4 - Versioning CID, Auditable, Best Practices, Extended Refunds)
 * @notice This contract enables ERC20-based crowdfunding campaigns with:
 *  - cancellation if no funds were donated,
 *  - a 14-day refund period when the target is not met,
 *  - withdrawal of remaining funds after the refund period,
 *  - versioning and auditable IPFS CIDs,
 *  - extended refunds for donors if the creator does not withdraw after 14 days.
 * @dev Inherits ReentrancyGuard, Ownable, Pausable. Uses “Check-Effects-Interactions”,
 *  NatSpec, and emits events for CID changes to ensure full transparency and historical traceability.
 */
contract Crowdfund is ReentrancyGuard, Ownable, Pausable {
    // --- Constants ---
    /// @notice Period during which donors can request refunds in a failed or manually closed campaign (14 days)
    uint256 public constant RECLAIM_PERIOD = 14 days;

    // --- Data Types ---
    /// @notice Campaign type: Startup or Charity
    enum CampaignType { Startup, Charity }
    /// @notice Current status of a campaign
    enum Status {
        Active,         // Campaign is open for donations
        Completed,      // Campaign reached its target
        Closing,        // Campaign manually closed by creator; donors may request refunds
        Withdrawn,      // Creator withdrew success funds
        ClosedByCreator,// Creator withdrew remaining funds after refund period
        Failed,         // Campaign failed after endTime; donors may request refunds
        Cancelled       // Campaign cancelled by creator (when no funds were donated)
    }

    /// @notice Structure representing a single crowdfunding campaign
    struct Campaign {
        address creator;             // Address of the campaign creator
        IERC20 acceptedToken;        // ERC20 token accepted for this campaign
        uint256 targetAmount;        // Target amount in smallest token units
        uint256 raisedAmount;        // Net amount raised (after donation commissions)
        uint256 totalEverRaised;     // Gross sum of all donations (before commissions)
        string dataCID;              // IPFS CID for campaign metadata (e.g., JSON with description)
        uint256 endTime;             // Unix timestamp when campaign ends
        Status status;               // Current status of the campaign
        uint256 creationTimestamp;   // Unix timestamp when campaign was created
        uint256 reclaimDeadline;     // Unix timestamp marking end of 14-day refund window
        CampaignType campaignType;   // Type of campaign (Startup or Charity)
    }

    // --- State Variables ---
    mapping(uint256 => Campaign) public campaigns;                   // campaignId => Campaign
    mapping(uint256 => mapping(address => uint256)) public donations;   // campaignId => (donor => net donation)
    mapping(uint256 => mapping(address => bool)) public hasReclaimed;  // campaignId => (donor => hasRefunded)

    uint256 public nextCampaignId = 1;           // Next campaign ID (auto-incremented)
    address public commissionWallet;             // Address where commissions are sent

    uint256 public startupDonationCommissionPercentage;  // Donation commission for Startup campaigns (0–10000)
    uint256 public charityDonationCommissionPercentage;  // Donation commission for Charity campaigns (0–10000)
    uint256 public refundCommissionPercentage;           // Refund commission when campaign is Active or Closing (0–10000)
    uint256 public startupSuccessCommissionPercentage;   // Success commission for Startup campaigns (0–10000)
    uint256 public charitySuccessCommissionPercentage;   // Success commission for Charity campaigns (0–10000)

    mapping(address => bool) public isTokenWhitelisted;    // Indicates whether a token is accepted
    mapping(string => address) public tokenSymbolToAddress; // Optional mapping from symbol to token address
    address[] public whitelistedTokens;                    // List of all whitelisted token addresses

    // --- Events ---
    event CampaignCreated(
        uint256 indexed campaignId,
        address indexed creator,
        address indexed acceptedToken,
        CampaignType campaignType,
        uint256 targetAmount,
        string dataCID,
        uint256 endTime,
        uint256 creationTimestamp
    );
    event DonationReceived(
        uint256 indexed campaignId,
        address indexed donor,
        address indexed tokenAddress,
        uint256 amountGiven,
        uint256 amountToCampaign,
        uint256 donationCommissionAmount,
        uint256 timestamp
    );
    event FundsWithdrawn(
        uint256 indexed campaignId,
        address indexed creator,
        address indexed tokenAddress,
        uint256 amountToCreator,
        uint256 successCommissionDeducted
    );
    event CampaignClosingInitiated(
        uint256 indexed campaignId,
        address indexed initiator,
        uint256 reclaimDeadline
    );
    event RefundClaimed(
        uint256 indexed campaignId,
        address indexed donor,
        address indexed tokenAddress,
        uint256 amountReturnedToDonor,
        uint256 refundCommissionAmount
    );
    event CampaignClosedByCreator(
        uint256 indexed campaignId,
        address indexed creator,
        address indexed tokenAddress,
        uint256 amountWithdrawn,
        uint256 commissionDeducted
    );
    event CampaignFailedAndClosed(
        uint256 indexed campaignId,
        uint256 endTime,
        uint256 reclaimDeadline
    );
    event FailedFundsWithdrawn(
        uint256 indexed campaignId,
        address indexed creator,
        address indexed tokenAddress,
        uint256 amountWithdrawn
    );
    event CampaignCancelled(
        uint256 indexed campaignId,
        address indexed creator
    );
    event CommissionWalletChanged(address indexed newWallet);
    event StartupDonationCommissionPercentageChanged(uint256 newPercentage);
    event CharityDonationCommissionPercentageChanged(uint256 newPercentage);
    event RefundCommissionPercentageChanged(uint256 newPercentage);
    event StartupSuccessCommissionPercentageChanged(uint256 newPercentage);
    event CharitySuccessCommissionPercentageChanged(uint256 newPercentage);
    event TokenWhitelisted(address indexed tokenAddress, string tokenSymbol);
    event TokenRemovedFromWhitelist(address indexed tokenAddress);
    /// @notice Emitted when a campaign's data CID is updated or removed
    event CampaignDataCIDUpdated(
        uint256 indexed campaignId,
        string oldCID,
        string newCID
    );

    // --- Custom Errors (to optimize gas) ---
    error TargetAmountMustBePositive();
    error EndTimeNotInFuture();
    error DataCIDCannotBeEmpty();
    error InvalidCampaignId();
    error CampaignNotActive();            // Used when an operation requires status == Active
    error CampaignNotRefundable();        // Used when refunds are not allowed
    error CampaignNotClosing();           // Used when expected status is Closing
    error CampaignNotCompleted();         // Used when expected status is Completed
    error CampaignNotFailed();            // Used when expected status is Failed
    error CampaignHasEnded();
    error DonationAmountMustBePositive();
    error NotCampaignCreator();
    error NoDonationToClaim();
    error TokenTransferFailed(address token, address recipient, uint256 amount);
    error AlreadyReclaimed();
    error ReclaimPeriodActive();
    error ReclaimPeriodOver();
    error InvalidCommissionPercentage();
    error CommissionWalletNotSet();
    error TokenNotWhitelisted(address tokenAddress);
    error TokenAlreadyWhitelisted(address tokenAddress);
    error TokenSymbolAlreadyExists(string tokenSymbol);
    error InvalidTokenAddress();
    error InsufficientTokenAllowance(address tokenOwner, address spender, uint256 required, uint256 current);
    error RefundAmountExceedsDonation();
    error CampaignHasDonations();
    error CannotWithdrawBeforeReclaimDeadline();
    error NoFundsToWithdraw();

    // --- Constructor ---
    /**
     * @notice Initializes the contract, sets owner and initial commission parameters.
     * @param _initialOwner Address of the contract owner (may differ from msg.sender).
     * @param _initialCommissionWallet Address where commissions are sent (must not be zero).
     * @param _initialStartupDonationCommPerc Donation commission for Startup campaigns (0–10000).
     * @param _initialCharityDonationCommPerc Donation commission for Charity campaigns (0–10000).
     * @param _initialRefundCommPerc Refund commission for Active/Closing campaigns (0–10000).
     * @param _initialStartupSuccessCommPerc Success commission for Startup campaigns (0–10000).
     * @param _initialCharitySuccessCommPerc Success commission for Charity campaigns (0–10000).
     * @dev Validates that all commission values ≤ 10000 and commission wallet is not zero.
     */
    constructor(
        address _initialOwner,
        address _initialCommissionWallet,
        uint256 _initialStartupDonationCommPerc,
        uint256 _initialCharityDonationCommPerc,
        uint256 _initialRefundCommPerc,
        uint256 _initialStartupSuccessCommPerc,
        uint256 _initialCharitySuccessCommPerc
    ) Ownable(_initialOwner) {
        if (_initialCommissionWallet == address(0)) revert CommissionWalletNotSet();
        if (_initialStartupDonationCommPerc > 10000) revert InvalidCommissionPercentage();
        if (_initialCharityDonationCommPerc > 10000) revert InvalidCommissionPercentage();
        if (_initialRefundCommPerc > 10000) revert InvalidCommissionPercentage();
        if (_initialStartupSuccessCommPerc > 10000) revert InvalidCommissionPercentage();
        if (_initialCharitySuccessCommPerc > 10000) revert InvalidCommissionPercentage();

        commissionWallet = _initialCommissionWallet;
        startupDonationCommissionPercentage = _initialStartupDonationCommPerc;
        charityDonationCommissionPercentage = _initialCharityDonationCommPerc;
        refundCommissionPercentage = _initialRefundCommPerc;
        startupSuccessCommissionPercentage = _initialStartupSuccessCommPerc;
        charitySuccessCommissionPercentage = _initialCharitySuccessCommPerc;
    }

    // --- Modifiers ---
    modifier whenNotPausedCustom() {
        require(!paused(), "Pausable: paused");
        _;
    }

    // --- Commission Management (Owner Only) ---
    /**
     * @notice Updates the commission wallet address.
     * @param _newCommissionWallet New address for commissions (must not be zero).
     */
    function setCommissionWallet(address _newCommissionWallet) public onlyOwner {
        if (_newCommissionWallet == address(0)) revert CommissionWalletNotSet();
        commissionWallet = _newCommissionWallet;
        emit CommissionWalletChanged(_newCommissionWallet);
    }

    /**
     * @notice Sets the donation commission percentage for Startup campaigns.
     * @param _newPercentage New commission (0–10000).
     */
    function setStartupDonationCommissionPercentage(uint256 _newPercentage) public onlyOwner {
        if (_newPercentage > 10000) revert InvalidCommissionPercentage();
        startupDonationCommissionPercentage = _newPercentage;
        emit StartupDonationCommissionPercentageChanged(_newPercentage);
    }

    /**
     * @notice Sets the donation commission percentage for Charity campaigns.
     * @param _newPercentage New commission (0–10000).
     */
    function setCharityDonationCommissionPercentage(uint256 _newPercentage) public onlyOwner {
        if (_newPercentage > 10000) revert InvalidCommissionPercentage();
        charityDonationCommissionPercentage = _newPercentage;
        emit CharityDonationCommissionPercentageChanged(_newPercentage);
    }

    /**
     * @notice Sets the refund commission percentage.
     * @param _newPercentage New commission (0–10000).
     */
    function setRefundCommissionPercentage(uint256 _newPercentage) public onlyOwner {
        if (_newPercentage > 10000) revert InvalidCommissionPercentage();
        refundCommissionPercentage = _newPercentage;
        emit RefundCommissionPercentageChanged(_newPercentage);
    }

    /**
     * @notice Sets the success commission percentage for Startup campaigns.
     * @param _newPercentage New commission (0–10000).
     */
    function setStartupSuccessCommissionPercentage(uint256 _newPercentage) public onlyOwner {
        if (_newPercentage > 10000) revert InvalidCommissionPercentage();
        startupSuccessCommissionPercentage = _newPercentage;
        emit StartupSuccessCommissionPercentageChanged(_newPercentage);
    }

    /**
     * @notice Sets the success commission percentage for Charity campaigns.
     * @param _newPercentage New commission (0–10000).
     */
    function setCharitySuccessCommissionPercentage(uint256 _newPercentage) public onlyOwner {
        if (_newPercentage > 10000) revert InvalidCommissionPercentage();
        charitySuccessCommissionPercentage = _newPercentage;
        emit CharitySuccessCommissionPercentageChanged(_newPercentage);
    }

    // --- Token Whitelist Management (Owner Only) ---
    /**
     * @notice Adds a token to the whitelist (accepted in campaigns).
     * @param _tokenAddress Address of the ERC20 token.
     * @param _tokenSymbol Optional symbol for mapping.
     * @dev Reverts if the address is zero, already whitelisted, or symbol conflict.
     */
    function addAcceptedToken(address _tokenAddress, string memory _tokenSymbol) public onlyOwner {
        if (_tokenAddress == address(0)) revert InvalidTokenAddress();
        if (isTokenWhitelisted[_tokenAddress]) revert TokenAlreadyWhitelisted(_tokenAddress);
        if (bytes(_tokenSymbol).length > 0 && tokenSymbolToAddress[_tokenSymbol] != address(0)) {
            revert TokenSymbolAlreadyExists(_tokenSymbol);
        }
        isTokenWhitelisted[_tokenAddress] = true;
        if (bytes(_tokenSymbol).length > 0) {
            tokenSymbolToAddress[_tokenSymbol] = _tokenAddress;
        }
        whitelistedTokens.push(_tokenAddress);
        emit TokenWhitelisted(_tokenAddress, _tokenSymbol);
    }

    /**
     * @notice Removes a token from the whitelist.
     * @param _tokenAddress Address of the token to remove.
     * @dev Reverts if the token is not whitelisted.
     */
    function removeAcceptedToken(address _tokenAddress) public onlyOwner {
        if (!isTokenWhitelisted[_tokenAddress]) revert TokenNotWhitelisted(_tokenAddress);
        isTokenWhitelisted[_tokenAddress] = false;
        for (uint256 i = 0; i < whitelistedTokens.length; i++) {
            if (whitelistedTokens[i] == _tokenAddress) {
                whitelistedTokens[i] = whitelistedTokens[whitelistedTokens.length - 1];
                whitelistedTokens.pop();
                break;
            }
        }
        emit TokenRemovedFromWhitelist(_tokenAddress);
    }

    // --- Campaign Functions (CRUD and Actions) ---

    /**
     * @notice Creates a new crowdfunding campaign.
     * @param _campaignType Type of the campaign (Startup or Charity).
     * @param _acceptedTokenAddress Address of the whitelisted ERC20 token.
     * @param _targetAmount Target amount (in smallest token units).
     * @param _dataCID IPFS CID for campaign metadata (e.g., JSON with description).
     * @param _endTime Unix timestamp when the campaign ends (must be > block.timestamp).
     * @return campaignId Generated ID of the new campaign.
     * @dev Reverts if the token is not whitelisted, target is zero, endTime ≤ now, dataCID is empty, or commission wallet is unset.
     */
    function createCampaign(
        CampaignType _campaignType,
        address _acceptedTokenAddress,
        uint256 _targetAmount,
        string memory _dataCID,
        uint256 _endTime
    ) public whenNotPausedCustom returns (uint256 campaignId) {
        if (!isTokenWhitelisted[_acceptedTokenAddress]) revert TokenNotWhitelisted(_acceptedTokenAddress);
        if (_targetAmount == 0) revert TargetAmountMustBePositive();
        if (_endTime <= block.timestamp) revert EndTimeNotInFuture();
        if (bytes(_dataCID).length == 0) revert DataCIDCannotBeEmpty();
        if (commissionWallet == address(0)) revert CommissionWalletNotSet();

        campaignId = nextCampaignId++;
        Campaign storage campaign = campaigns[campaignId];

        campaign.creator = msg.sender;
        campaign.acceptedToken = IERC20(_acceptedTokenAddress);
        campaign.campaignType = _campaignType;
        campaign.targetAmount = _targetAmount;
        campaign.dataCID = _dataCID;
        campaign.endTime = _endTime;
        campaign.status = Status.Active;
        campaign.creationTimestamp = block.timestamp;
        // reclaimDeadline remains zero until status changes to Failed or Closing

        emit CampaignCreated(
            campaignId,
            msg.sender,
            _acceptedTokenAddress,
            _campaignType,
            _targetAmount,
            _dataCID,
            _endTime,
            block.timestamp
        );
    }

    /**
     * @notice Updates the campaign's IPFS data CID.
     * @param _campaignId ID of the campaign to update.
     * @param _newCID New IPFS CID (e.g., updated JSON on IPFS).
     * @dev Only the campaign creator can call. Emits a versioning event.
     */
    function updateDataCID(uint256 _campaignId, string memory _newCID) public {
        if (!(_campaignId > 0 && _campaignId < nextCampaignId && campaigns[_campaignId].creationTimestamp > 0)) {
            revert InvalidCampaignId();
        }
        Campaign storage campaign = campaigns[_campaignId];
        if (msg.sender != campaign.creator) revert NotCampaignCreator();
        if (bytes(_newCID).length == 0) revert DataCIDCannotBeEmpty();

        string memory oldCID = campaign.dataCID;
        campaign.dataCID = _newCID;
        emit CampaignDataCIDUpdated(_campaignId, oldCID, _newCID);
    }

    /**
     * @notice Removes the campaign's IPFS data CID (sets to empty string).
     * @param _campaignId ID of the campaign whose CID will be removed.
     * @dev Only the campaign creator can call. Emits a versioning event with newCID = "".
     */
    function removeDataCID(uint256 _campaignId) public {
        if (!(_campaignId > 0 && _campaignId < nextCampaignId && campaigns[_campaignId].creationTimestamp > 0)) {
            revert InvalidCampaignId();
        }
        Campaign storage campaign = campaigns[_campaignId];
        if (msg.sender != campaign.creator) revert NotCampaignCreator();

        string memory oldCID = campaign.dataCID;
        campaign.dataCID = "";
        emit CampaignDataCIDUpdated(_campaignId, oldCID, "");
    }

    /**
     * @notice Cancels a campaign if no donations have been made.
     * @param _campaignId ID of the campaign to cancel.
     * @dev Only the campaign creator can call. Reverts if raisedAmount > 0. Sets status = Cancelled.
     */
    function cancelCampaign(uint256 _campaignId) public whenNotPausedCustom {
        if (!(_campaignId > 0 && _campaignId < nextCampaignId && campaigns[_campaignId].creationTimestamp > 0)) {
            revert InvalidCampaignId();
        }
        Campaign storage campaign = campaigns[_campaignId];
        if (msg.sender != campaign.creator) revert NotCampaignCreator();
        if (campaign.raisedAmount > 0) revert CampaignHasDonations();

        campaign.status = Status.Cancelled;
        emit CampaignCancelled(_campaignId, msg.sender);
    }

    /**
     * @notice Donates to an active campaign.
     * @param _campaignId ID of the campaign to donate to.
     * @param _donationAmount Gross donation amount (in smallest token units).
     * @dev Checks campaign validity, status = Active, endTime not passed, positive amount, and sufficient allowance.
     *      Applies donation commission and transfers net amount to campaign storage, commission to commissionWallet.
     *      Updates raisedAmount and totalEverRaised. Resets refund flag. If raisedAmount ≥ target, sets status = Completed.
     */
    function donate(uint256 _campaignId, uint256 _donationAmount) public nonReentrant whenNotPausedCustom {
        if (!(_campaignId > 0 && _campaignId < nextCampaignId && campaigns[_campaignId].creationTimestamp > 0)) {
            revert InvalidCampaignId();
        }
        Campaign storage campaign = campaigns[_campaignId];
        IERC20 token = campaign.acceptedToken;

        if (address(token) == address(0)) revert InvalidTokenAddress();
        if (campaign.status != Status.Active) revert CampaignNotActive();
        if (block.timestamp >= campaign.endTime) revert CampaignHasEnded();
        if (_donationAmount == 0) revert DonationAmountMustBePositive();
        if (commissionWallet == address(0)) revert CommissionWalletNotSet();

        // Check allowance
        uint256 currentAllowance = token.allowance(msg.sender, address(this));
        if (currentAllowance < _donationAmount) {
            revert InsufficientTokenAllowance(msg.sender, address(this), _donationAmount, currentAllowance);
        }

        // Calculate donation commission
        uint256 donationCommRate = (campaign.campaignType == CampaignType.Startup)
            ? startupDonationCommissionPercentage
            : charityDonationCommissionPercentage;
        uint256 actualDonationCommission = (_donationAmount * donationCommRate) / 10000;
        uint256 amountToCampaign = _donationAmount - actualDonationCommission;

        // Transfer gross donation
        bool success = token.transferFrom(msg.sender, address(this), _donationAmount);
        if (!success) revert TokenTransferFailed(address(token), address(this), _donationAmount);

        // Transfer commission to commissionWallet
        if (actualDonationCommission > 0) {
            success = token.transfer(commissionWallet, actualDonationCommission);
            if (!success) revert TokenTransferFailed(address(token), commissionWallet, actualDonationCommission);
        }

        // Update campaign state and donor's net donation
        campaign.raisedAmount += amountToCampaign;
        campaign.totalEverRaised += _donationAmount;
        donations[_campaignId][msg.sender] += amountToCampaign;

        // Reset refund flag for this donor
        hasReclaimed[_campaignId][msg.sender] = false;

        // If target reached, mark as Completed
        if (campaign.raisedAmount >= campaign.targetAmount && campaign.targetAmount > 0) {
            campaign.status = Status.Completed;
        }

        emit DonationReceived(
            _campaignId,
            msg.sender,
            address(token),
            _donationAmount,
            amountToCampaign,
            actualDonationCommission,
            block.timestamp
        );
    }

    /**
     * @notice Allows donors to claim refunds.
     * @param _campaignId ID of the campaign to refund from.
     * @dev Applicable when status = Active, Closing, or Failed.
     *      - If Closing: must be before reclaimDeadline.
     *      - If Failed: donors can claim even after reclaimDeadline.
     *      Computes refund commission only if status ≠ Failed. Transfers commission then returns net to donor.
     *      Updates raisedAmount and marks donor as reclaimed. If campaign was Completed but falls below target, set to Active.
     */
    function claimRefund(uint256 _campaignId) public nonReentrant whenNotPausedCustom {
        if (!(_campaignId > 0 && _campaignId < nextCampaignId && campaigns[_campaignId].creationTimestamp > 0)) {
            revert InvalidCampaignId();
        }
        Campaign storage campaign = campaigns[_campaignId];
        Status currentStatus = campaign.status;
        IERC20 token = campaign.acceptedToken;

        // Only Active, Closing, or Failed are refundable
        if (currentStatus != Status.Active && currentStatus != Status.Closing && currentStatus != Status.Failed) {
            revert CampaignNotRefundable();
        }

        // If Closing, check reclaimDeadline
        // Pozwalamy na refund także przy timestamp == reclaimDeadline oraz reclaimDeadline + 1
        if (currentStatus == Status.Closing && block.timestamp > campaign.reclaimDeadline + 1) {
            revert ReclaimPeriodOver();
        }
        // If Failed, donors can refund even after reclaimDeadline

        // Check if donor already reclaimed
        if (hasReclaimed[_campaignId][msg.sender]) revert AlreadyReclaimed();

        // Check donor's net donation
        uint256 netDonationByDonor = donations[_campaignId][msg.sender];
        if (netDonationByDonor == 0) revert NoDonationToClaim();

        // Calculate refund commission if status ≠ Failed
        uint256 actualRefundCommission = 0;
        uint256 amountToReturnToDonor = netDonationByDonor;
        if (currentStatus != Status.Failed && refundCommissionPercentage > 0) {
            actualRefundCommission = (netDonationByDonor * refundCommissionPercentage) / 10000;
            if (actualRefundCommission > netDonationByDonor) {
                revert RefundAmountExceedsDonation();
            }
            amountToReturnToDonor = netDonationByDonor - actualRefundCommission;
        }

        // Update state: mark reclaimed, zero out donation, reduce raisedAmount
        hasReclaimed[_campaignId][msg.sender] = true;
        donations[_campaignId][msg.sender] = 0;
        campaign.raisedAmount -= netDonationByDonor;

        // If campaign was Completed and now below target, revert to Active
        if (campaign.status == Status.Completed && campaign.raisedAmount < campaign.targetAmount) {
            campaign.status = Status.Active;
        }

        emit RefundClaimed(
            _campaignId,
            msg.sender,
            address(token),
            amountToReturnToDonor,
            actualRefundCommission
        );

        // Transfer refund commission then donor's net refund
        if (actualRefundCommission > 0) {
            bool commissionSuccess = token.transfer(commissionWallet, actualRefundCommission);
            if (!commissionSuccess) revert TokenTransferFailed(address(token), commissionWallet, actualRefundCommission);
        }
        if (amountToReturnToDonor > 0) {
            bool donorSuccess = token.transfer(msg.sender, amountToReturnToDonor);
            if (!donorSuccess) revert TokenTransferFailed(address(token), msg.sender, amountToReturnToDonor);
        }
    }

    /**
     * @notice Initiates manual closure of a campaign before endTime, allowing refunds for 14 days.
     * @param _campaignId ID of the campaign to close.
     * @dev Only the creator can call. Status must be Active. Sets status = Closing and reclaimDeadline = now + 14 days.
     */
    function initiateClosure(uint256 _campaignId) public nonReentrant whenNotPausedCustom {
        if (!(_campaignId > 0 && _campaignId < nextCampaignId && campaigns[_campaignId].creationTimestamp > 0)) {
            revert InvalidCampaignId();
        }
        Campaign storage campaign = campaigns[_campaignId];

        if (msg.sender != campaign.creator) revert NotCampaignCreator();
        if (campaign.status != Status.Active) revert CampaignNotActive();

        campaign.status = Status.Closing;
        campaign.reclaimDeadline = block.timestamp + RECLAIM_PERIOD;
        emit CampaignClosingInitiated(_campaignId, msg.sender, campaign.reclaimDeadline);
    }

    /**
     * @notice Finalizes closure (after reclaimDeadline) and allows creator to withdraw remaining funds.
     * @param _campaignId ID of the campaign to finalize.
     * @dev Only the creator can call. Status must be Closing and now ≥ reclaimDeadline.
     *      Transfers all raisedAmount to creator, sets status = ClosedByCreator.
     */
    function finalizeClosureAndWithdraw(uint256 _campaignId) public nonReentrant whenNotPausedCustom {
        if (!(_campaignId > 0 && _campaignId < nextCampaignId && campaigns[_campaignId].creationTimestamp > 0)) {
            revert InvalidCampaignId();
        }
        Campaign storage campaign = campaigns[_campaignId];
        IERC20 token = campaign.acceptedToken;

        if (msg.sender != campaign.creator) revert NotCampaignCreator();
        if (campaign.status != Status.Closing) revert CampaignNotClosing();
        if (block.timestamp < campaign.reclaimDeadline) revert ReclaimPeriodActive();

        uint256 amountToWithdraw = campaign.raisedAmount;
        campaign.raisedAmount = 0;
        campaign.status = Status.ClosedByCreator;
        emit CampaignClosedByCreator(_campaignId, msg.sender, address(token), amountToWithdraw, 0);

        if (amountToWithdraw > 0) {
            bool success = token.transfer(campaign.creator, amountToWithdraw);
            if (!success) revert TokenTransferFailed(address(token), campaign.creator, amountToWithdraw);
        }
    }

    /**
     * @notice Marks a campaign as Failed (after endTime) if the target was not met, enabling refunds.
     * @param _campaignId ID of the campaign to mark as Failed.
     * @dev Reverts if status ≠ Active, now < endTime, or target already met. Sets status = Failed and reclaimDeadline = now + 14 days.
     */
    function failCampaignIfUnsuccessful(uint256 _campaignId) public whenNotPausedCustom {
        if (!(_campaignId > 0 && _campaignId < nextCampaignId && campaigns[_campaignId].creationTimestamp > 0)) {
            revert InvalidCampaignId();
        }
        Campaign storage campaign = campaigns[_campaignId];

        if (campaign.status != Status.Active) revert CampaignNotRefundable();
        if (block.timestamp < campaign.endTime) revert EndTimeNotInFuture();
        if (campaign.targetAmount > 0 && campaign.raisedAmount >= campaign.targetAmount) {
            revert("CampaignTargetMetCannotFail");
        }
        campaign.status = Status.Failed;
        campaign.reclaimDeadline = block.timestamp + RECLAIM_PERIOD;
        emit CampaignFailedAndClosed(_campaignId, campaign.endTime, campaign.reclaimDeadline);
    }

    /**
     * @notice Allows creator to withdraw funds from a Failed campaign after 14-day refund window.
     * @param _campaignId ID of the campaign to withdraw from.
     * @dev Only the creator can call. Status must be Failed and now > reclaimDeadline. Transfers raisedAmount, sets status = ClosedByCreator.
     */
    function withdrawFailedCampaignFunds(uint256 _campaignId) public nonReentrant whenNotPausedCustom {
        if (!(_campaignId > 0 && _campaignId < nextCampaignId && campaigns[_campaignId].creationTimestamp > 0)) {
            revert InvalidCampaignId();
        }
        Campaign storage campaign = campaigns[_campaignId];
        IERC20 token = campaign.acceptedToken;

        if (msg.sender != campaign.creator) revert NotCampaignCreator();
        if (campaign.status != Status.Failed) revert CampaignNotFailed();
        if (block.timestamp <= campaign.reclaimDeadline) revert CannotWithdrawBeforeReclaimDeadline();

        uint256 amountToWithdraw = campaign.raisedAmount;
        if (amountToWithdraw == 0) revert NoFundsToWithdraw();

        campaign.raisedAmount = 0;
        campaign.status = Status.ClosedByCreator;
        emit FailedFundsWithdrawn(_campaignId, msg.sender, address(token), amountToWithdraw);

        bool success = token.transfer(campaign.creator, amountToWithdraw);
        if (!success) revert TokenTransferFailed(address(token), campaign.creator, amountToWithdraw);
    }

    /**
     * @notice Allows creator to withdraw funds from a Completed campaign, net of success commission.
     * @param _campaignId ID of the Completed campaign.
     * @dev Only the creator can call. Status must be Completed. Charges success commission, transfers remainder to creator, sets status = Withdrawn.
     */
    function withdrawFunds(uint256 _campaignId) public nonReentrant whenNotPausedCustom {
        if (!(_campaignId > 0 && _campaignId < nextCampaignId && campaigns[_campaignId].creationTimestamp > 0)) {
            revert InvalidCampaignId();
        }
        Campaign storage campaign = campaigns[_campaignId];
        IERC20 token = campaign.acceptedToken;

        if (msg.sender != campaign.creator) revert NotCampaignCreator();
        if (campaign.status != Status.Completed) revert CampaignNotCompleted();

        uint256 amountAvailableForWithdrawal = campaign.raisedAmount;
        uint256 successCommRate = (campaign.campaignType == CampaignType.Startup)
            ? startupSuccessCommissionPercentage
            : charitySuccessCommissionPercentage;

        uint256 actualSuccessCommission = 0;
        uint256 amountToCreator = amountAvailableForWithdrawal;
        if (successCommRate > 0) {
            actualSuccessCommission = (amountAvailableForWithdrawal * successCommRate) / 10000;
            if (actualSuccessCommission > amountAvailableForWithdrawal) {
                actualSuccessCommission = amountAvailableForWithdrawal;
            }
            amountToCreator = amountAvailableForWithdrawal - actualSuccessCommission;
        }

        campaign.raisedAmount = 0;
        campaign.status = Status.Withdrawn;
        emit FundsWithdrawn(_campaignId, msg.sender, address(token), amountToCreator, actualSuccessCommission);

        if (actualSuccessCommission > 0) {
            bool commissionSuccess = token.transfer(commissionWallet, actualSuccessCommission);
            if (!commissionSuccess) revert TokenTransferFailed(address(token), commissionWallet, actualSuccessCommission);
        }
        if (amountToCreator > 0) {
            bool creatorSuccess = token.transfer(campaign.creator, amountToCreator);
            if (!creatorSuccess) revert TokenTransferFailed(address(token), campaign.creator, amountToCreator);
        }
    }

    // --- Pause Management (Owner Only) ---
    /// @notice Pauses all functions protected by whenNotPausedCustom.
    function pauseContract() public onlyOwner {
        _pause();
    }

    /// @notice Unpauses all functions protected by whenNotPausedCustom.
    function unpauseContract() public onlyOwner {
        _unpause();
    }

    // --- View Functions ---

    /**
     * @notice Returns all details of a campaign.
     * @param _campaignId ID of the campaign.
     * @return campaignData Full Campaign struct data.
     */
    function getCampaignDetails(uint256 _campaignId) public view returns (Campaign memory campaignData) {
        if (!(_campaignId > 0 && _campaignId < nextCampaignId && campaigns[_campaignId].creationTimestamp > 0)) {
            revert InvalidCampaignId();
        }
        return campaigns[_campaignId];
    }

    /**
     * @notice Returns a list of all campaigns (use off-chain pagination for large sets).
     * @return Array of Campaign structs.
     */
    function getAllCampaigns() public view returns (Campaign[] memory) {
        uint256 campaignCount = nextCampaignId - 1;
        Campaign[] memory allCampaignsArray = new Campaign[](campaignCount);
        for (uint256 i = 1; i <= campaignCount; i++) {
            allCampaignsArray[i - 1] = campaigns[i];
        }
        return allCampaignsArray;
    }

    /**
     * @notice Returns the creator address of a campaign.
     * @param _campaignId ID of the campaign.
     * @return creatorAddress Address of the campaign creator.
     */
    function getCampaignCreator(uint256 _campaignId) public view returns (address creatorAddress) {
        if (!(_campaignId > 0 && _campaignId < nextCampaignId && campaigns[_campaignId].creationTimestamp > 0)) {
            revert InvalidCampaignId();
        }
        return campaigns[_campaignId].creator;
    }

    /**
     * @notice Returns the net amount donated by a specific donor to a campaign.
     * @param _campaignId ID of the campaign.
     * @param _donor Address of the donor.
     * @return Net donation amount (after donation commissions).
     */
    function getDonationAmountForDonor(uint256 _campaignId, address _donor) public view returns (uint256) {
        if (!(_campaignId > 0 && _campaignId < nextCampaignId)) {
            revert InvalidCampaignId();
        }
        return donations[_campaignId][_donor];
    }

    /**
     * @notice Returns the list of whitelisted token addresses.
     * @return Array of whitelisted token addresses.
     */
    function getWhitelistedTokens() public view returns (address[] memory) {
        return whitelistedTokens;
    }

    /**
     * @notice Checks if a token is whitelisted.
     * @param _tokenAddress Address of the token.
     * @return True if the token is whitelisted, false otherwise.
     */
    function checkIsTokenWhitelisted(address _tokenAddress) public view returns (bool) {
        return isTokenWhitelisted[_tokenAddress];
    }

    /**
     * @notice Helper function returning true if a campaign is effectively failed (endTime passed, target not met),
     *         even if its stored status is still Active because failCampaignIfUnsuccessful has not been called.
     * @param _id ID of the campaign.
     * @return True if status is Active, now > endTime, and raisedAmount < targetAmount.
     */
    function isActuallyFailed(uint256 _id) public view returns (bool) {
        Campaign storage c = campaigns[_id];
        return (c.status == Status.Active && block.timestamp > c.endTime && c.raisedAmount < c.targetAmount);
    }
}
