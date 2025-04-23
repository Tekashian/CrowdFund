/** @type import('hardhat/config').HardhatUserConfig */

// Importuj wymagane wtyczki i moduły na początku pliku
require("@nomicfoundation/hardhat-toolbox"); // Zawiera ethers, chai, etc.
require('solidity-coverage'); // Dla raportów pokrycia kodu (jeśli używasz)
require('dotenv').config(); // Wczytuje zmienne z pliku .env
require("hardhat-gas-reporter"); // Do raportowania zużycia gazu (jeśli używasz)

// Odczytaj zmienne środowiskowe (upewnij się, że są zdefiniowane w pliku .env)
const SEPOLIA_RPC_URL = process.env.SEPOLIA_RPC_URL || "https://rpc.sepolia.org"; // Domyślny publiczny RPC jako fallback
const BSC_TESTNET_RPC_URL = process.env.BSC_TESTNET_RPC_URL || "https://bsc-testnet-dataseed.bnbchain.org"; // Odczytuje URL BSC Testnet z .env lub używa domyślnego
const PRIVATE_KEY = process.env.PRIVATE_KEY; // Klucz prywatny konta wdrożeniowego (ten sam dla obu sieci w tym przykładzie)
// WAŻNE: W środowisku produkcyjnym używaj OSOBNYCH kluczy dla różnych sieci!
const COINMARKETCAP_API_KEY = process.env.COINMARKETCAP_API_KEY || ""; // Klucz API dla cen gazu (opcjonalny)
const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY || ""; // Klucz API Etherscan do weryfikacji (opcjonalny)
const BSCSCAN_API_KEY = process.env.BSCSCAN_API_KEY || ""; // Klucz API BSCScan do weryfikacji (opcjonalny)

// Główny obiekt konfiguracyjny Hardhat
module.exports = {
  // --- SEKCJA SOLIDITY Z WŁĄCZONYM OPTYMALIZATOREM ---
  solidity: {
    version: "0.8.20", // Wersja Solidity spójna z kontraktami
    settings: {
      optimizer: {
        enabled: true, // Włącz optymalizator kompilatora Solidity
        runs: 200,     // Standardowa wartość 'runs'.
      },
    },
  },
  // --- KONIEC SEKCJI SOLIDITY ---

  // Domyślna sieć używana przez Hardhat, jeśli nie podano flagi --network
  defaultNetwork: "hardhat",

  // Konfiguracja sieci
  networks: {
    hardhat: {
      // Domyślna konfiguracja dla lokalnej sieci Hardhat
      chainId: 31337, // Standardowy chain ID dla sieci Hardhat
    },
    // --- KONFIGURACJA SIECI TESTOWEJ ETHEREUM (SEPOLIA) ---
    sepolia: {
      url: SEPOLIA_RPC_URL, // Odczytuje URL RPC z pliku .env
      // Używa klucza prywatnego z pliku .env (upewnij się, że zmienna nazywa się PRIVATE_KEY)
      accounts: PRIVATE_KEY ? [`0x${PRIVATE_KEY}`] : [], // Dodaje prefix 0x; obsługuje brak klucza
      chainId: 11155111, // Oficjalny Chain ID dla sieci Sepolia
    },
    // --- KONIEC KONFIGURACJI SEPOLIA ---

    // --- NOWA KONFIGURACJA SIECI TESTOWEJ BINANCE SMART CHAIN (BSC TESTNET) ---
    bscTestnet: {
        url: BSC_TESTNET_RPC_URL, // Odczytuje URL RPC dla BSC Testnet z pliku .env
        // Używa tego samego klucza prywatnego co Sepolia w tym przykładzie. Zalecane użycie osobnego klucza dla bezpieczeństwa.
        accounts: PRIVATE_KEY ? [`0x${PRIVATE_KEY}`] : [], // Dodaje prefix 0x; obsługuje brak klucza
        chainId: 97, // Oficjalny Chain ID dla sieci BSC Testnet
    },
    // --- KONIEC KONFIGURACJI BSC TESTNET ---

    // Można dodać inne sieci (np. mainnet ETH, mainnet BSC) w przyszłości
  },

  // Konfiguracja wtyczki hardhat-gas-reporter
  gasReporter: {
    enabled: true, // Włącz raportowanie gazu przy 'npx hardhat test'
    currency: 'USD', // Waluta do estymacji kosztów (wymaga klucza API poniżej)
    coinmarketcap: COINMARKETCAP_API_KEY, // Klucz API CoinMarketCap (z pliku .env)
    outputFile: 'gas-report.txt', // Możesz odkomentować, jeśli chcesz zapisu do pliku
    noColors: true, // Wyłącza kolory (przydatne przy zapisie do pliku)
    // Można dodać specyficzne ustawienia dla różnych sieci, np. token dla BSC
    // L1: "ethereum", // Domyślnie
    // L2: "bsc", // Można określić, jeśli raportujemy dla L2
    // token: "BNB", // Dla sieci BSC
    // gasPriceApi: "https://api.bscscan.com/api?module=proxy&action=eth_gasPrice" // API ceny gazu dla BSC
  },

  // Konfiguracja dla wtyczki hardhat-etherscan (do weryfikacji kontraktów na Etherscan i BSCScan)
  etherscan: {
    apiKey: {
      // Klucze API dla różnych eksploratorów
      mainnet: ETHERSCAN_API_KEY, // Dla Ethereum Mainnet
      sepolia: ETHERSCAN_API_KEY, // Dla Sepolia Testnet
      bsc: BSCSCAN_API_KEY,       // Dla BSC Mainnet
      bscTestnet: BSCSCAN_API_KEY // Dla BSC Testnet
      // Możesz dodać inne sieci np. polygon, arbitrum etc.
    },
    customChains: [ // Definicje niestandardowych sieci dla wtyczki
      {
        network: "bscTestnet",
        chainId: 97,
        urls: {
          apiURL: "https://api-testnet.bscscan.com/api", // Adres API BSCScan Testnet
          browserURL: "https://testnet.bscscan.com" // Adres strony BSCScan Testnet
        }
      },
      {
        network: "bsc",
        chainId: 56,
        urls: {
          apiURL: "https://api.bscscan.com/api", // Adres API BSCScan Mainnet
          browserURL: "https://bscscan.com" // Adres strony BSCScan Mainnet
        }
      }
      // Możesz dodać definicje dla innych sieci EVM
    ]
  },

  // Definicja ścieżek projektu (zazwyczaj standardowe wartości Hardhata)
  paths: {
    sources: "./contracts",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts"
  },

  // Konfiguracja Mocha (frameworka testowego używanego przez Hardhat)
  mocha: {
    timeout: 40000 // Zwiększony timeout (w milisekundach) dla testów, przydatne przy interakcjach z sieciami testowymi
  }
};
