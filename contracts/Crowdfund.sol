// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";

/**
 * @title Crowdfund Contract (Refactored v5.5.2 - Streamlined Reverts, Comprehensive NatSpec, Fair Failed Refunds, Advanced Commissions)
 * @author [Twoje Imię/Nazwa Firmy/Pseudonim Developera]
 * @notice This contract facilitates ERC20-based crowdfunding campaigns, offering distinct commission structures for donations, withdrawals, and refunds.
 * @dev Inherits ReentrancyGuard, Ownable, Pausable. All monetary values handled per-campaign in chosen ERC20.
 */
contract Crowdfund is ReentrancyGuard, Ownable, Pausable {

    // --- Constants ---
    uint256 public constant RECLAIM_PERIOD = 14 days;

    // --- State Variables ---

    enum CampaignType { Startup, Charity }
    enum Status { Active, Completed, Closing, Withdrawn, ClosedByCreator, Failed }

    struct Campaign {
        address creator;
        IERC20 acceptedToken;
        uint256 targetAmount;
        uint256 raisedAmount;
        uint256 totalEverRaised;
        string dataCID;
        uint256 endTime;
        Status status;
        uint256 creationTimestamp;
        uint256 reclaimDeadline;
        CampaignType campaignType;
    }

    mapping(uint256 => Campaign) public campaigns;
    mapping(uint256 => mapping(address => uint256)) public donations;
    mapping(uint256 => mapping(address => bool)) public hasReclaimed;

    uint256 public nextCampaignId = 1;
    address public commissionWallet;

    uint256 public startupDonationCommissionPercentage;
    uint256 public charityDonationCommissionPercentage;
    uint256 public refundCommissionPercentage;
    uint256 public startupSuccessCommissionPercentage;
    uint256 public charitySuccessCommissionPercentage;

    mapping(address => bool) public isTokenWhitelisted;
    mapping(string => address) public tokenSymbolToAddress;
    address[] public whitelistedTokens;

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
    event CampaignClosingInitiated(uint256 indexed campaignId, address indexed initiator, uint256 reclaimDeadline);
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
    event CampaignFailedAndClosed(uint256 indexed campaignId, uint256 endTime);

    event CommissionWalletChanged(address indexed newWallet);
    event StartupDonationCommissionPercentageChanged(uint256 newPercentage);
    event CharityDonationCommissionPercentageChanged(uint256 newPercentage);
    event RefundCommissionPercentageChanged(uint256 newPercentage);
    event StartupSuccessCommissionPercentageChanged(uint256 newPercentage);
    event CharitySuccessCommissionPercentageChanged(uint256 newPercentage);
    event TokenWhitelisted(address indexed tokenAddress, string tokenSymbol);
    event TokenRemovedFromWhitelist(address indexed tokenAddress);

    // --- Custom Errors ---
    error TargetAmountMustBePositive();
    error EndTimeNotInFuture();
    error DataCIDCannotBeEmpty();
    error InvalidCampaignId();
    error CampaignNotActive();
    error CampaignNotRefundable();
    error CampaignNotClosing();
    error CampaignNotCompleted();
    error CampaignNotFailed();
    error CampaignHasEnded();
    error CampaignReclaimPeriodNotOver();
    error DonationAmountMustBePositive();
    error NotCampaignCreator();
    error NoDonationToClaim();
    error TokenTransferFailed(address token, address recipient, uint256 amount);
    error AlreadyReclaimed();
    error ReclaimPeriodActive();
    error ReclaimPeriodOver();
    error CannotCloseCompletedCampaign();
    error CannotCloseFailedCampaign();
    error InvalidCommissionPercentage();
    error CommissionWalletNotSet();
    error TokenNotWhitelisted(address tokenAddress);
    error TokenAlreadyWhitelisted(address tokenAddress);
    error TokenSymbolAlreadyExists(string tokenSymbol);
    error InvalidTokenAddress();
    error InsufficientTokenAllowance(address tokenOwner, address spender, uint256 required, uint256 current);
    error RefundAmountExceedsDonation();

    // --- Constructor ---
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

    // --- Modifier ---
    modifier whenNotPausedCustom() {
        require(!paused(), "Pausable: paused");
        _;
    }

    // --- Commission Management Functions (Owner Only) ---

    function setCommissionWallet(address _newCommissionWallet) public onlyOwner {
        if (_newCommissionWallet == address(0)) revert CommissionWalletNotSet();
        commissionWallet = _newCommissionWallet;
        emit CommissionWalletChanged(_newCommissionWallet);
    }

    function setStartupDonationCommissionPercentage(uint256 _newPercentage) public onlyOwner {
        if (_newPercentage > 10000) revert InvalidCommissionPercentage();
        startupDonationCommissionPercentage = _newPercentage;
        emit StartupDonationCommissionPercentageChanged(_newPercentage);
    }

    function setCharityDonationCommissionPercentage(uint256 _newPercentage) public onlyOwner {
        if (_newPercentage > 10000) revert InvalidCommissionPercentage();
        charityDonationCommissionPercentage = _newPercentage;
        emit CharityDonationCommissionPercentageChanged(_newPercentage);
    }

    function setRefundCommissionPercentage(uint256 _newPercentage) public onlyOwner {
        if (_newPercentage > 10000) revert InvalidCommissionPercentage();
        refundCommissionPercentage = _newPercentage;
        emit RefundCommissionPercentageChanged(_newPercentage);
    }

    function setStartupSuccessCommissionPercentage(uint256 _newPercentage) public onlyOwner {
        if (_newPercentage > 10000) revert InvalidCommissionPercentage();
        startupSuccessCommissionPercentage = _newPercentage;
        emit StartupSuccessCommissionPercentageChanged(_newPercentage);
    }

    function setCharitySuccessCommissionPercentage(uint256 _newPercentage) public onlyOwner {
        if (_newPercentage > 10000) revert InvalidCommissionPercentage();
        charitySuccessCommissionPercentage = _newPercentage;
        emit CharitySuccessCommissionPercentageChanged(_newPercentage);
    }

    // --- Token Whitelisting Functions (Owner Only) ---
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

    function removeAcceptedToken(address _tokenAddress) public onlyOwner {
        if (!isTokenWhitelisted[_tokenAddress]) revert TokenNotWhitelisted(_tokenAddress);
        isTokenWhitelisted[_tokenAddress] = false;
        for (uint i = 0; i < whitelistedTokens.length; i++) {
            if (whitelistedTokens[i] == _tokenAddress) {
                whitelistedTokens[i] = whitelistedTokens[whitelistedTokens.length - 1];
                whitelistedTokens.pop();
                break;
            }
        }
        emit TokenRemovedFromWhitelist(_tokenAddress);
    }

    // --- Campaign Management Functions ---

    function createCampaign(
        CampaignType _campaignType,
        address _acceptedTokenAddress,
        uint256 _targetAmount,
        string memory _dataCID,
        uint256 _endTime
    ) public whenNotPausedCustom {
        if (!isTokenWhitelisted[_acceptedTokenAddress]) revert TokenNotWhitelisted(_acceptedTokenAddress);
        if (_targetAmount == 0) revert TargetAmountMustBePositive();
        if (_endTime <= block.timestamp) revert EndTimeNotInFuture();
        if (bytes(_dataCID).length == 0) revert DataCIDCannotBeEmpty();
        if (commissionWallet == address(0)) revert CommissionWalletNotSet();

        uint256 campaignId = nextCampaignId++;
        Campaign storage campaign = campaigns[campaignId];
        campaign.creator = msg.sender;
        campaign.acceptedToken = IERC20(_acceptedTokenAddress);
        campaign.campaignType = _campaignType;
        campaign.targetAmount = _targetAmount;
        campaign.dataCID = _dataCID;
        campaign.endTime = _endTime;
        campaign.status = Status.Active;
        campaign.creationTimestamp = block.timestamp;

        emit CampaignCreated(
            campaignId, msg.sender, _acceptedTokenAddress, _campaignType, _targetAmount, _dataCID, _endTime, block.timestamp
        );
    }

    /**
     * @notice Donate to a campaign – now with improved commission payout order for ERC20 tokens (like USDC).
     */
    function donate(uint256 _campaignId, uint256 _donationAmount) public nonReentrant whenNotPausedCustom {
        if (!(_campaignId > 0 && _campaignId < nextCampaignId && campaigns[_campaignId].creationTimestamp > 0)) revert InvalidCampaignId();
        Campaign storage campaign = campaigns[_campaignId];
        IERC20 token = campaign.acceptedToken;

        if (address(token) == address(0)) revert InvalidTokenAddress();
        if (campaign.status != Status.Active) revert CampaignNotActive();
        if (block.timestamp >= campaign.endTime) revert CampaignHasEnded();
        if (_donationAmount == 0) revert DonationAmountMustBePositive();
        if (commissionWallet == address(0)) revert CommissionWalletNotSet();

        uint256 currentAllowance = token.allowance(msg.sender, address(this));
        if (currentAllowance < _donationAmount) {
            revert InsufficientTokenAllowance(msg.sender, address(this), _donationAmount, currentAllowance);
        }

        uint256 donationCommRate = (campaign.campaignType == CampaignType.Startup)
            ? startupDonationCommissionPercentage
            : charityDonationCommissionPercentage;
        uint256 actualDonationCommission = (_donationAmount * donationCommRate) / 10000;
        uint256 amountToCampaign = _donationAmount - actualDonationCommission;

        // --- Interactions: Najpierw transferujemy całość z portfela użytkownika do kontraktu
        bool success = token.transferFrom(msg.sender, address(this), _donationAmount);
        if (!success) revert TokenTransferFailed(address(token), address(this), _donationAmount);

        // --- Interactions: Potem wysyłamy prowizję na wallet prowizyjny (z kontraktu)
        if (actualDonationCommission > 0) {
            success = token.transfer(commissionWallet, actualDonationCommission);
            if (!success) revert TokenTransferFailed(address(token), commissionWallet, actualDonationCommission);
        }

        // --- Effects: Dopiero teraz zapisujemy dotację netto i podbijamy stan kampanii
        campaign.raisedAmount += amountToCampaign;
        campaign.totalEverRaised += _donationAmount;
        donations[_campaignId][msg.sender] += amountToCampaign;

        if (campaign.raisedAmount >= campaign.targetAmount && campaign.targetAmount > 0) {
            campaign.status = Status.Completed;
        }
        emit DonationReceived(
            _campaignId, msg.sender, address(token), _donationAmount, amountToCampaign, actualDonationCommission, block.timestamp
        );
    }

    function claimRefund(uint256 _campaignId) public nonReentrant whenNotPausedCustom {
        if (!(_campaignId > 0 && _campaignId < nextCampaignId && campaigns[_campaignId].creationTimestamp > 0)) revert InvalidCampaignId();
        Campaign storage campaign = campaigns[_campaignId];
        Status currentStatus = campaign.status;
        IERC20 token = campaign.acceptedToken;

        if (currentStatus != Status.Active && currentStatus != Status.Closing && currentStatus != Status.Failed) {
            revert CampaignNotRefundable();
        }
        if (currentStatus == Status.Closing && block.timestamp >= campaign.reclaimDeadline) {
            revert ReclaimPeriodOver();
        }

        uint256 netDonationByDonor = donations[_campaignId][msg.sender];
        if (netDonationByDonor == 0) revert NoDonationToClaim();
        if (hasReclaimed[_campaignId][msg.sender]) revert AlreadyReclaimed();

        uint256 actualRefundCommission = 0;
        uint256 amountToReturnToDonor = netDonationByDonor;

        if (currentStatus != Status.Failed && refundCommissionPercentage > 0) {
            actualRefundCommission = (netDonationByDonor * refundCommissionPercentage) / 10000;
            if (actualRefundCommission > netDonationByDonor) { 
                revert RefundAmountExceedsDonation();
            }
            amountToReturnToDonor = netDonationByDonor - actualRefundCommission;
        }

        hasReclaimed[_campaignId][msg.sender] = true;
        donations[_campaignId][msg.sender] = 0;
        campaign.raisedAmount -= netDonationByDonor;

        if (campaign.status == Status.Completed && campaign.raisedAmount < campaign.targetAmount) {
            campaign.status = Status.Active;
        }
        emit RefundClaimed(_campaignId, msg.sender, address(token), amountToReturnToDonor, actualRefundCommission);

        if (actualRefundCommission > 0) {
            bool commissionSuccess = token.transfer(commissionWallet, actualRefundCommission);
            if (!commissionSuccess) {
                revert TokenTransferFailed(address(token), commissionWallet, actualRefundCommission);
            }
        }
        if (amountToReturnToDonor > 0) {
            bool donorSuccess = token.transfer(msg.sender, amountToReturnToDonor);
            if (!donorSuccess) {
                revert TokenTransferFailed(address(token), msg.sender, amountToReturnToDonor);
            }
        }
    }

    function initiateClosure(uint256 _campaignId) public nonReentrant whenNotPausedCustom {
        if (!(_campaignId > 0 && _campaignId < nextCampaignId && campaigns[_campaignId].creationTimestamp > 0)) revert InvalidCampaignId();
        Campaign storage campaign = campaigns[_campaignId];

        if (msg.sender != campaign.creator) revert NotCampaignCreator();
        if (campaign.status == Status.Completed) revert CannotCloseCompletedCampaign();
        if (campaign.status == Status.Failed) revert CannotCloseFailedCampaign();
        if (campaign.status != Status.Active) revert CampaignNotActive();

        campaign.status = Status.Closing;
        campaign.reclaimDeadline = block.timestamp + RECLAIM_PERIOD;
        emit CampaignClosingInitiated(_campaignId, msg.sender, campaign.reclaimDeadline);
    }

    function finalizeClosureAndWithdraw(uint256 _campaignId) public nonReentrant whenNotPausedCustom {
        if (!(_campaignId > 0 && _campaignId < nextCampaignId && campaigns[_campaignId].creationTimestamp > 0)) revert InvalidCampaignId();
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
            if (!success) {
                revert TokenTransferFailed(address(token), campaign.creator, amountToWithdraw);
            }
        }
    }

    function withdrawFunds(uint256 _campaignId) public nonReentrant whenNotPausedCustom {
        if (!(_campaignId > 0 && _campaignId < nextCampaignId && campaigns[_campaignId].creationTimestamp > 0)) revert InvalidCampaignId();
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
            if (!commissionSuccess) {
                revert TokenTransferFailed(address(token), commissionWallet, actualSuccessCommission);
            }
        }
        if (amountToCreator > 0) {
            bool creatorSuccess = token.transfer(campaign.creator, amountToCreator);
            if (!creatorSuccess) {
                revert TokenTransferFailed(address(token), campaign.creator, amountToCreator);
            }
        }
    }

    function failCampaignIfUnsuccessful(uint256 _campaignId) public whenNotPausedCustom {
        if (!(_campaignId > 0 && _campaignId < nextCampaignId && campaigns[_campaignId].creationTimestamp > 0)) revert InvalidCampaignId();
        Campaign storage campaign = campaigns[_campaignId];

        if (campaign.status != Status.Active) revert CampaignNotActive();
        if (block.timestamp < campaign.endTime) revert EndTimeNotInFuture();
        if (campaign.targetAmount > 0 && campaign.raisedAmount >= campaign.targetAmount) {
            revert("CampaignTargetMetCannotFail");
        }
        campaign.status = Status.Failed;
        emit CampaignFailedAndClosed(_campaignId, campaign.endTime);
    }

    // --- Pausable Control (Owner Only) ---
    function pauseContract() public onlyOwner { _pause(); }
    function unpauseContract() public onlyOwner { _unpause(); }

    // --- View Functions ---
    function getCampaignDetails(uint256 _campaignId) public view returns (Campaign memory campaignData) {
        if (!(_campaignId > 0 && _campaignId < nextCampaignId && campaigns[_campaignId].creationTimestamp > 0)) {
             revert InvalidCampaignId();
        }
        return campaigns[_campaignId];
    }
    function getAllCampaigns() public view returns (Campaign[] memory) {
        uint256 campaignCount = nextCampaignId - 1;
        Campaign[] memory allCampaignsArray = new Campaign[](campaignCount);
        for (uint256 i = 1; i <= campaignCount; i++) {
            allCampaignsArray[i-1] = campaigns[i];
        }
        return allCampaignsArray;
    }
    function getCampaignCreator(uint256 _campaignId) public view returns (address creatorAddress) {
        if (!(_campaignId > 0 && _campaignId < nextCampaignId && campaigns[_campaignId].creationTimestamp > 0)) {
            revert InvalidCampaignId();
        }
        return campaigns[_campaignId].creator;
    }
    function getDonationAmountForDonor(uint256 _campaignId, address _donor) public view returns (uint256) {
        if (!(_campaignId > 0 && _campaignId < nextCampaignId)) {
            revert InvalidCampaignId();
        }
        return donations[_campaignId][_donor];
    }
    function getWhitelistedTokens() public view returns (address[] memory) {
        return whitelistedTokens;
    }
    function checkIsTokenWhitelisted(address _tokenAddress) public view returns (bool) {
        return isTokenWhitelisted[_tokenAddress];
    }
}
