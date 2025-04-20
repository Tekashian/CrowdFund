/** @type import('hardhat/config').HardhatUserConfig */

// Importuj wymagane wtyczki i moduły na początku pliku
require("@nomicfoundation/hardhat-toolbox"); // Zawiera ethers, chai, etc.
require('solidity-coverage'); // Dla raportów pokrycia kodu
require('dotenv').config(); // Wczytuje zmienne z pliku .env
require("hardhat-gas-reporter"); // Do raportowania zużycia gazu

// Odczytaj zmienne środowiskowe (upewnij się, że są zdefiniowane w pliku .env)
const SEPOLIA_RPC_URL = process.env.SEPOLIA_RPC_URL || "https://rpc.sepolia.org"; // Domyślny publiczny RPC jako fallback
const PRIVATE_KEY = process.env.PRIVATE_KEY; // Klucz prywatny konta wdrożeniowego
const COINMARKETCAP_API_KEY = process.env.COINMARKETCAP_API_KEY || ""; // Klucz API dla cen gazu (opcjonalny)
// const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY || ""; // Klucz API Etherscan do weryfikacji (opcjonalny)

// Główny obiekt konfiguracyjny Hardhat
module.exports = {
  // --- SEKCJA SOLIDITY Z WŁĄCZONYM OPTYMALIZATOREM ---
  solidity: {
    version: "0.8.20", // Wersja Solidity spójna z kontraktami
    settings: {
      optimizer: {
        enabled: true, // Włącz optymalizator kompilatora Solidity
        runs: 200,     // Standardowa wartość 'runs'. Wpływa na kompromis
                       // między kosztem wdrożenia a kosztem wykonania funkcji.
                       // 200 to często używana wartość domyślna.
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
    // --- ODKOMENTOWANA I POPRAWIONA KONFIGURACJA SEPOLIA ---
    sepolia: {
      url: SEPOLIA_RPC_URL, // Odczytuje URL RPC z pliku .env
      // Używa klucza prywatnego z pliku .env (upewnij się, że zmienna nazywa się PRIVATE_KEY)
      accounts: PRIVATE_KEY ? [`0x${PRIVATE_KEY}`] : [], // Dodaje prefix 0x; obsługuje brak klucza
      chainId: 11155111, // Oficjalny Chain ID dla sieci Sepolia
    },
    // --- KONIEC KONFIGURACJI SEPOLIA ---
    // Można dodać inne sieci (np. mainnet, goerli) w przyszłości
  },

  // Konfiguracja wtyczki hardhat-gas-reporter
  gasReporter: {
    enabled: true, // Włącz raportowanie gazu przy 'npx hardhat test'
    currency: 'USD', // Waluta do estymacji kosztów (wymaga klucza API poniżej)
    coinmarketcap: COINMARKETCAP_API_KEY, // Klucz API CoinMarketCap (z pliku .env)
    outputFile: 'gas-report.txt', // Możesz odkomentować, jeśli chcesz zapisu do pliku
    noColors: true, // Wyłącza kolory (przydatne przy zapisie do pliku)
  },

  // Opcjonalna konfiguracja dla wtyczki hardhat-etherscan (do weryfikacji kontraktów)
  /*
  etherscan: {
    apiKey: process.env.ETHERSCAN_API_KEY // Klucz API Etherscan (z pliku .env)
  },
  */

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
