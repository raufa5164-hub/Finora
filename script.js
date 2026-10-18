
// ═══════════════════════════════════════════════════════════════
// ── CLOUD ACCOUNT + OFFLINE SYNC + PWA ─────────────────────────
// ═══════════════════════════════════════════════════════════════

const FIREBASE_CONFIG = {
  apiKey: "AIzaSyCo0JMo55iG3BJN7IwXa87u3Dn_rmjUo6U",
  authDomain: "finora-236a5.firebaseapp.com",
  projectId: "finora-236a5",
  storageBucket: "finora-236a5.firebasestorage.app",
  messagingSenderId: "720795318376",
  appId: "1:720795318376:web:0ff84a6aa98a0af507a3dd",
};

let firebaseApp = null;
let firebaseAuth = null;
let firestoreDb = null;
let cloudUser = null;
let cloudUnsubscribe = null;
let cloudSyncEnabled = false;
let cloudWriteTimer = null;
let applyingCloudSnapshot = false;
let pendingCloudSync = false;
let deferredInstallPrompt = null;
const DEVICE_ID_KEY = "sbtDeviceId";
const LOCAL_UPDATED_KEY = "sbtLocalUpdatedAt";
const CLOUD_STATE_VERSION = 4;

function getDeviceId() {
  let id = localStorage.getItem(DEVICE_ID_KEY);
  if (!id) {
    id = (crypto?.randomUUID?.() || `device-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    localStorage.setItem(DEVICE_ID_KEY, id);
  }
  return id;
}

function firebaseConfigured() {
  return (
    typeof firebase !== "undefined" &&
    FIREBASE_CONFIG.apiKey &&
    !FIREBASE_CONFIG.apiKey.startsWith("YOUR_") &&
    FIREBASE_CONFIG.projectId &&
    !FIREBASE_CONFIG.projectId.startsWith("YOUR_") &&
    FIREBASE_CONFIG.appId &&
    !FIREBASE_CONFIG.appId.startsWith("YOUR_")
  );
}

function updateSyncUI(state = {}) {
  const label = document.getElementById("sync-state-label");
  const lastSync = document.getElementById("last-sync");
  const nameEl = document.getElementById("user-name");
  const statusEl = document.getElementById("user-account-status");
  const photoEl = document.getElementById("user-photo");
  const guestEl = document.getElementById("guest-avatar");
  const signInBtn = document.getElementById("google-signin-btn");
  const signOutBtn = document.getElementById("google-signout-btn");

  const online = navigator.onLine;
  const user = state.user || cloudUser;

  if (user) {
    if (nameEl) nameEl.textContent = user.displayName || "User";
    if (statusEl) statusEl.textContent = state.accountStatus || (online ? "Cloud synced" : "Offline • saved locally");
    if (photoEl) {
      if (user.photoURL) {
        photoEl.src = user.photoURL;
        photoEl.alt = `${user.displayName || "User"} profile photo`;
        photoEl.hidden = false;

        photoEl.onerror = () => {
          photoEl.hidden = true;
          if (guestEl) guestEl.hidden = false;
        };
      } else {
        photoEl.hidden = true;
        photoEl.removeAttribute("src");
      }
    }

    if (guestEl) {
      guestEl.hidden = Boolean(user.photoURL);
    }
  
    if (signInBtn) signInBtn.hidden = true;
    if (signOutBtn) signOutBtn.hidden = false;
  } else {
    if (nameEl) nameEl.textContent = "Guest";
    if (statusEl) statusEl.textContent = online ? "Local data" : "Offline • saved locally";
    if (photoEl) photoEl.hidden = true;
    if (guestEl) guestEl.hidden = false;
    if (signInBtn) signInBtn.hidden = false;
    if (signOutBtn) signOutBtn.hidden = true;
  }

  if (label) {
    label.textContent =
      !online ? "Offline • Saved locally" :
      cloudSyncEnabled && cloudUser ? "🟢 Synced" :
      "Local Mode";
  }

  if (lastSync) {
    const stamp = state.lastSyncAt || localStorage.getItem(LOCAL_UPDATED_KEY);
    lastSync.textContent = stamp
      ? `Updated: ${new Date(stamp).toLocaleTimeString()}`
      : "Updated: Never";
  }
}

function markLocalUpdated() {
  const stamp = Date.now();
  localStorage.setItem(LOCAL_UPDATED_KEY, String(stamp));
  updateSyncUI({ lastSyncAt: stamp });
}

function getCloudPayload() {
  return {
    version: CLOUD_STATE_VERSION,
    data: getDataPayload(),
    updatedAt: Date.now(),
    deviceId: getDeviceId(),
  };
}

function getCloudDocRef(uid = cloudUser?.uid) {
  if (!firestoreDb || !uid) return null;
  return firestoreDb.collection("users").doc(uid).collection("app").doc("state");
}

async function initializeFirebase() {
  if (!firebaseConfigured()) {
    updateSyncUI();
    return false;
  }

  try {
    if (!firebase.apps.length) {
      firebaseApp = firebase.initializeApp(FIREBASE_CONFIG);
    } else {
      firebaseApp = firebase.app();
    }

    firebaseAuth = firebaseApp.auth();
    firestoreDb = firebaseApp.firestore();

    try {
      await firestoreDb.enablePersistence({ synchronizeTabs: true });
    } catch (error) {
      console.warn("Firestore offline persistence could not be enabled:", error);
    }

    firebaseAuth.onAuthStateChanged(async (user) => {
      cloudUser = user || null;
      const welcome = document.getElementById("first-visit-prompt");
      if (user) {
        localStorage.setItem("finoraWelcomeChoice", "signed-in");
        if (welcome) welcome.hidden = true;
      } else if (welcome && !localStorage.getItem("finoraWelcomeChoice")) {
        welcome.hidden = false;
      }

      if (cloudUnsubscribe) {
        cloudUnsubscribe();
        cloudUnsubscribe = null;
      }

      if (!user) {
        cloudSyncEnabled = false;
        updateSyncUI();
        return;
      }

      await handleCloudLogin(user);
    });

    cloudSyncEnabled = true;
    updateSyncUI();
    return true;
  } catch (error) {
    console.error("Firebase initialization failed:", error);
    cloudSyncEnabled = false;
    updateSyncUI();
    return false;
  }
}

async function signInWithGoogle() {
  if (!firebaseConfigured()) {
    alert(
      "Google sign-in is not configured yet. Add your Firebase Web App configuration to script.js first."
    );
    return;
  }

  if (!firebaseAuth) {
    const ok = await initializeFirebase();
    if (!ok) return;
  }

  try {
    const provider = new firebase.auth.GoogleAuthProvider();
    provider.setCustomParameters({ prompt: "select_account" });
    await firebaseAuth.signInWithPopup(provider);
  } catch (error) {
    console.error("Google sign-in failed:", error);

    if (error?.code === "auth/popup-blocked") {
      alert("Your browser blocked the Google sign-in window. Please allow pop-ups and try again.");
    } else if (error?.code === "auth/popup-closed-by-user") {
      // User cancelled; no alert needed.
    } else {
      alert(`Google sign-in failed: ${error?.message || "Unknown error"}`);
    }
  }
}
window.signInWithGoogle = signInWithGoogle;

async function signOutUser() {
  if (!firebaseAuth) return;
  try {
    await firebaseAuth.signOut();
    cloudUser = null;
    cloudSyncEnabled = false;
    if (cloudUnsubscribe) cloudUnsubscribe();
    cloudUnsubscribe = null;
    updateSyncUI();
  } catch (error) {
    console.error("Sign out failed:", error);
    alert("Could not sign out. Please try again.");
  }
}
window.signOutUser = signOutUser;

async function handleCloudLogin(user) {
  updateSyncUI({
    user,
    accountStatus: navigator.onLine ? "Connecting…" : "Offline • saved locally",
  });

  const ref = getCloudDocRef(user.uid);
  if (!ref) return;

  try {
    const snap = await ref.get({ source: navigator.onLine ? "default" : "cache" });
    const localPayload = getDataPayload();
    const hasLocalData =
      localPayload.expenses.length > 0 ||
      localPayload.wallets.length > 0 ||
      Number(localPayload.income) !== 0 ||
      Number(localPayload.goal) !== 0;

    if (!snap.exists) {
      if (hasLocalData) {
        const shouldUpload = confirm(
          "We found budget data on this device. Upload this existing data to your Google account?"
        );

        if (shouldUpload) {
          await writeCloudState();
        } else {
          applyDataPayload({});
          await persistData({ skipCloud: true });
          await writeCloudState();
        }
      } else {
        await writeCloudState();
      }
    } else {
      const cloud = snap.data() || {};
      const cloudUpdated = Number(cloud.updatedAt || 0);
      const localUpdated = Number(localStorage.getItem(LOCAL_UPDATED_KEY) || 0);

      if (hasLocalData && localUpdated > cloudUpdated + 1000) {
        const useLocal = confirm(
          "This device has newer local budget data than the cloud copy. Upload this device's data to your Google account?"
        );

        if (useLocal) {
          await writeCloudState();
        } else {
          applyDataPayload(cloud.data || {});
          await persistData({ skipCloud: true });
        }
      } else {
        applyDataPayload(cloud.data || {});
        await persistData({ skipCloud: true });
      }
    }
    cloudSyncEnabled = true;
    subscribeToCloudState(user.uid);
    updateSyncUI({
      user,
      accountStatus: navigator.onLine
        ? "Cloud synced"
        : "Offline • saved locally",
    });
      
  } catch (error) {
    console.error("Cloud login/load failed:", error);
    updateSyncUI({ user, accountStatus: navigator.onLine ? "Sync unavailable" : "Offline • saved locally" });
  }
}

function subscribeToCloudState(uid) {
  const ref = getCloudDocRef(uid);
  if (!ref) return;

  if (cloudUnsubscribe) cloudUnsubscribe();

  cloudUnsubscribe = ref.onSnapshot(
    (snap) => {
      if (!snap.exists || applyingCloudSnapshot) return;

      const cloud = snap.data() || {};
      const cloudUpdated = Number(cloud.updatedAt || 0);
      const localUpdated = Number(localStorage.getItem(LOCAL_UPDATED_KEY) || 0);

      // Ignore our own older snapshot and any snapshot older than local pending changes.
      if (cloudUpdated < localUpdated) {
        return;
      }

      applyingCloudSnapshot = true;
      try {
        applyDataPayload(cloud.data || {});
        localStorage.setItem(LOCAL_UPDATED_KEY, String(cloudUpdated || Date.now()));
        persistData({ skipCloud: true }).catch((error) =>
          console.warn("Cloud snapshot local save failed:", error)
        );
        refresh();
        renderWallets();
        updateUINotes();
        updateCurrencyUI();
        updateSyncUI({
          user: cloudUser,
          lastSyncAt: cloudUpdated || Date.now(),
          accountStatus: navigator.onLine ? "Cloud synced" : "Offline • saved locally",
        });
      } finally {
        applyingCloudSnapshot = false;
      }
    },
    (error) => {
      console.error("Cloud listener failed:", error);
      updateSyncUI({
        user: cloudUser,
        accountStatus: navigator.onLine ? "Sync error" : "Offline • saved locally",
      });
    }
  );
}

function queueCloudSync() {
  if (!cloudUser || !cloudSyncEnabled || applyingCloudSnapshot) return;

  pendingCloudSync = true;
  clearTimeout(cloudWriteTimer);
  cloudWriteTimer = setTimeout(() => {
    writeCloudState().catch((error) => {
      console.error("Queued cloud sync failed:", error);
    });
  }, 500);
}

async function writeCloudState() {
  if (!cloudUser || !firestoreDb || applyingCloudSnapshot) return false;

  const ref = getCloudDocRef(cloudUser.uid);
  if (!ref) return false;

  const payload = getCloudPayload();
  pendingCloudSync = false;

  try {
    await ref.set(
      {
        ...payload,
        profile: {
          displayName: cloudUser.displayName || "User",
          photoURL: cloudUser.photoURL || "",
        },
      },
      { merge: true }
    );

    localStorage.setItem(LOCAL_UPDATED_KEY, String(payload.updatedAt));
    updateSyncUI({
      user: cloudUser,
      lastSyncAt: payload.updatedAt,
      accountStatus: navigator.onLine ? "Cloud synced" : "Offline • saved locally",
    });
    return true;
  } catch (error) {
    console.warn("Cloud write queued/failed:", error);
    updateSyncUI({
      user: cloudUser,
      accountStatus: navigator.onLine ? "Sync pending" : "Offline • saved locally",
    });
    return false;
  }
}

async function syncWhenOnline() {
  updateSyncUI({ user: cloudUser });

  if (!navigator.onLine || !cloudUser) return;

  try {
    await writeCloudState();
  } catch (error) {
    console.warn("Online sync failed:", error);
  }
}

window.addEventListener("online", () => {
  updateSyncUI({ user: cloudUser, accountStatus: "Syncing…" });
  syncWhenOnline();
});

window.addEventListener("offline", () => {
  updateSyncUI({ user: cloudUser, accountStatus: "Offline • saved locally" });
});

// PWA install prompt
window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  deferredInstallPrompt = event;

  const container = document.getElementById("pwa-install-container");
  if (container) container.style.display = "flex";
});

window.addEventListener("appinstalled", () => {
  deferredInstallPrompt = null;
  const container = document.getElementById("pwa-install-container");
  if (container) container.style.display = "none";
});

async function installPWA() {
  if (!deferredInstallPrompt) {
    alert("Your browser does not currently offer an install prompt. On mobile, use the browser's 'Add to Home Screen' option.");
    return;
  }

  deferredInstallPrompt.prompt();
  await deferredInstallPrompt.userChoice;
  deferredInstallPrompt = null;

  const container = document.getElementById("pwa-install-container");
  if (container) container.style.display = "none";
}
window.installPWA = installPWA;

function registerPWAServiceWorker() {
  if (!("serviceWorker" in navigator) || location.protocol === "file:") return;

  navigator.serviceWorker
    .register("./sw.js")
    .then((registration) => {
      console.log("PWA service worker registered:", registration.scope);
    })
    .catch((error) => {
      console.warn("PWA service worker registration failed:", error);
    });
}

const fallbackRates = { INR: 1, USD: 0.012, EUR: 0.011, GBP: 0.0094 };
const currencySymbols = {
  INR: "\u20b9",
  USD: "$",
  EUR: "\u20ac",
  GBP: "\u00a3",
};

Object.assign(currencySymbols, {
  INR: "\u20b9",
  USD: "$",
  EUR: "\u20ac",
  GBP: "\u00a3",
});

const STORAGE_KEYS = [
  "expenses",
  "income",
  "goal",
  "categoryCaps",
  "currency",
  "wallets",
  "budgetRating",
  "selectedWalletId",
  "selectedIncomeWalletId",
  "activeView",
];
const VAULT_KEY = "secureVault";
const RATE_CACHE_KEY = "exchangeRateCache";
const IDB_NAME = "smartExpenseTrackerDb";
const IDB_STORE = "appState";
const IDB_STATE_KEY = "latest";
let encryptionKey = null;
let encryptionSalt = "";
let encryptedMode = Boolean(localStorage.getItem(VAULT_KEY));
let appWorker = null;
let dbPromise = null;

function loadCachedExchangeRates() {
  const cached = safeJSONParse(localStorage.getItem(RATE_CACHE_KEY), null);
  return cached?.rates ? { ...fallbackRates, ...cached.rates } : fallbackRates;
}

function loadPlainData() {
  return {
    expenses: safeJSONParse(localStorage.getItem("expenses"), []),
    income: parseFloat(localStorage.getItem("income")) || 0,
    goal: parseFloat(localStorage.getItem("goal")) || 0,
    categoryCaps: safeJSONParse(localStorage.getItem("categoryCaps"), {}),
    currency: localStorage.getItem("currency") || "INR",
    wallets: safeJSONParse(localStorage.getItem("wallets"), []),
    transfers: safeJSONParse(localStorage.getItem("finoraTransfers"), []),
    budgetRating: Math.max(0, Math.min(100, parseInt(localStorage.getItem("budgetRating"), 10) || 50)),
    selectedWalletId: localStorage.getItem("selectedWalletId") || "",
    selectedIncomeWalletId:
      localStorage.getItem("selectedIncomeWalletId") || "",
    activeView: localStorage.getItem("activeView") || "dashboard",
  };
}

const initialData = loadPlainData();
Object.assign(currencySymbols, {
  INR: "\u20b9",
  USD: "$",
  EUR: "\u20ac",
  GBP: "\u00a3",
});

window.state = {
  expenses: initialData.expenses,
  income: initialData.income,
  goal: initialData.goal,
  categoryCaps: initialData.categoryCaps,
  currentPage: 1,
  pageSize: 10,
  filteredData: [],
  trendChartInstance: null,
  budgetChartInstance: null,
  categoryChartInstance: null,
  currency: initialData.currency,
  exchangeRates: loadCachedExchangeRates(),
  wallets: initialData.wallets,
  transfers: Array.isArray(initialData.transfers) ? initialData.transfers : [],
  budgetRating: initialData.budgetRating,
  selectedWalletId: initialData.selectedWalletId,
  selectedIncomeWalletId: initialData.selectedIncomeWalletId,
  activeView: initialData.activeView,
  selectedTransactionIds: new Set(),
  budgetLock: localStorage.getItem("budgetLock") === "true",
  heatmapOffset: 0,
  user: null,
};

const categoryMap = {
  Food: [
    "food",
    "Biryani",
    "pizza",
    "burger",
    "dinner",
    "lunch",
    "breakfast",
    "swiggy",
    "zomato",
    "chai",
    "coffee",
    "snacks",
    "tea",
    "maggi",
    "samosa",
    "roll",
    "sandwich",
    "momos",
    "pasta",
    "biryani",
    "dessert",
    "icecream",
    "restaurant",
    "restuarant",
    "Chhola Bhatura",
  ],
  Grocery: [
    "grocery",
    "rice",
    "oil",
    "spices",
    "masala",
    "salt",
    "sugar",
    "atta",
    "dal",
    "pulses",
    "ghee",
    "butter",
    "milk",
    "curd",
    "paneer",
    "eggs",
    "bread",
    "ration",
    "blinkit",
    "zepto",
    "bigbasket",
  ],
  Vegetables: [
    "vegetables",
    "onion",
    "tomato",
    "potato",
    "bhindi",
    "ginger",
    "garlic",
    "chili",
    "lemon",
    "coriander",
    "spinach",
    "cauliflower",
    "cabbage",
    "carrot",
    "cucumber",
    "capsicum",
    "brinjal",
    "peas",
    "mushroom",
    "beans",
    "sabzi",
  ],
  Transport: [
    "transport",
    "petrol",
    "diesel",
    "uber",
    "ola",
    "auto",
    "rapido",
    "bus",
    "train",
    "metro",
    "ticket",
    "flight",
    "cab",
    "fuel",
    "parking",
    "toll",
  ],
  Rent: [
    "rent",
    "room",
    "pg",
    "hostel",
    "flat",
    "deposit",
    "brokerage",
    "maintenance",
  ],
  Shopping: [
    "shopping",
    "clothes",
    "shoes",
    "amazon",
    "flipkart",
    "myntra",
    "shirt",
    "jeans",
    "watch",
    "mobile",
    "laptop",
    "mall",
    "bag",
    "electronics",
    "sneakers",
  ],
  Subscription: [
    "subscription",
    "netflix",
    "prime",
    "spotify",
    "hotstar",
    "gym",
    "recharge",
    "jio",
    "airtel",
    "wifi",
    "broadband",
    "youtube",
  ],
  "Free Trial": ["trial", "free trial", "demo", "trial plan"],
};

const subcategoryMap = {
  Food: ["Groceries", "Restaurants", "Coffee", "Snacks", "Delivery"],
  Grocery: ["Monthly Ration", "Dairy", "Household", "Personal Care"],
  Vegetables: ["Fresh Vegetables", "Fruits", "Herbs"],
  Transport: ["Fuel", "Cab", "Metro", "Bus", "Parking"],
  Rent: ["Rent", "Maintenance", "Deposit"],
  Shopping: ["Clothing", "Electronics", "Accessories", "Gifts"],
  Subscription: ["Streaming", "Music", "Gym", "Mobile", "Internet"],
  "Free Trial": ["Trial", "Renewal Watch"],
  Other: ["General"],
};

document.addEventListener("DOMContentLoaded", async () => {
  await initializeStorage();
  initializeTheme();
  updateSyncUI();
  registerPWAServiceWorker();
  const installButton = document.getElementById("btn-pwa-install");
  if (installButton) installButton.addEventListener("click", installPWA);
  initializeNavigation();
  initializeFinoraUX();
  //initializeWorker();
  await hydrateFromIndexedDB();
  ensureDefaultWallet();

  const dateInput = document.getElementById("date");
  if (dateInput) dateInput.value = new Date().toISOString().split("T")[0];
  const transferDateInput = document.getElementById("transfer-date");
  if (transferDateInput) transferDateInput.value = new Date().toISOString().split("T")[0];
  resetDateFilters();
  updateUINotes();
  updateCurrencyUI();
  renderWallets();
  persistActiveWalletSelections();
  updateSecurityStatus();
  refresh();
  //registerServiceWorker();
  fetchExchangeRates();
  bindEnterSubmit();
  bindVoiceButton();
  bindWalletSelectors();

  // Restore period dates to inputs
  const savedFrom = localStorage.getItem("financeFrom") || "";
  const savedTo = localStorage.getItem("financeTo") || "";
  const fromInput = document.getElementById("finance-from");
  const toInput = document.getElementById("finance-to");
  if (fromInput && savedFrom) fromInput.value = savedFrom;
  if (toInput && savedTo) toInput.value = savedTo;

  // Check finance period status (notify on end date, warn 3 days before, alert if overdue)
  checkFinancePeriodStatus();
  // Check wallet periods too
  checkWalletPeriods();

  // ── New feature initializers ──────────────────────────────
  initSIPTracker();
  initAutoResetUI();
  initEmailConfigUI();
  initBudgetLockUI();
  initPushNotificationUI();
  checkMonthlyAutoReset();
  renderSpendingHeatmap();
  detectAnomalies();
  await initializeFirebase();
  syncWhenOnline();
});


function initializeFinoraUX() {
  const editForm = document.getElementById("edit-transaction-form");
  editForm?.addEventListener("submit", saveEditedTransaction);
  document.getElementById("edit-transaction-cancel")?.addEventListener("click", closeEditTransactionModal);
  document.getElementById("edit-transaction-close")?.addEventListener("click", closeEditTransactionModal);
  document.getElementById("edit-transaction-modal")?.addEventListener("click", (event) => {
    if (event.target.id === "edit-transaction-modal") closeEditTransactionModal();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeEditTransactionModal();
  });
  document.addEventListener("click", (event) => {
    const button = event.target.closest("[data-edit-transaction]");
    if (button) window.editTransaction(button.dataset.editTransaction);
  });
  const walletPanel = document.getElementById("wallet-manager-panel");
  const walletToggle = document.getElementById("toggle-wallet-panel");
  const transferPanel = document.getElementById("wallet-transfer-panel");
  const transferToggle = document.getElementById("toggle-wallet-transfer");
  const setWalletActionActive = (active) => {
    [walletToggle, transferToggle].forEach((button) => {
      if (!button) return;
      const isActive = button === active;
      button.classList.toggle("is-active", isActive);
      button.setAttribute("aria-expanded", String(isActive));
    });
  };
  walletToggle?.addEventListener("click", () => {
    if (!walletPanel) return;
    const shouldOpen = walletPanel.classList.contains("wallet-form-collapsed");
    walletPanel.classList.toggle("wallet-form-collapsed", !shouldOpen);
    if (transferPanel) transferPanel.classList.add("wallet-transfer-collapsed");
    if (transferToggle) transferToggle.textContent = "↔ Wallet Transfer";
    walletToggle.textContent = shouldOpen ? "Hide Wallet Form" : "+ Add Wallet";
    setWalletActionActive(shouldOpen ? walletToggle : null);
    if (shouldOpen) {
      walletPanel.scrollIntoView({ behavior: "smooth", block: "start" });
      document.getElementById("wallet-name")?.focus({ preventScroll: true });
    }
  });
  transferToggle?.addEventListener("click", () => {
    if (!transferPanel) return;
    const shouldOpen = transferPanel.classList.contains("wallet-transfer-collapsed");
    transferPanel.classList.toggle("wallet-transfer-collapsed", !shouldOpen);
    if (walletPanel) walletPanel.classList.add("wallet-form-collapsed");
    if (walletToggle) walletToggle.textContent = "+ Add Wallet";
    transferToggle.textContent = shouldOpen ? "Hide Wallet Transfer" : "↔ Wallet Transfer";
    setWalletActionActive(shouldOpen ? transferToggle : null);
    if (shouldOpen) transferPanel.scrollIntoView({ behavior: "smooth", block: "start" });
  });

  document.querySelectorAll("[data-toggle-limit-module]").forEach((button) => {
    button.addEventListener("click", () => {
      const moduleName = button.dataset.toggleLimitModule;
      const panel = document.querySelector(`[data-limit-module="${moduleName}"]`);
      if (!panel) return;
      const willOpen = panel.dataset.limitOpen !== "true";
      // Only one finance tool can be open at a time.
      document.querySelectorAll("[data-toggle-limit-module]").forEach((otherButton) => {
        const otherName = otherButton.dataset.toggleLimitModule;
        const otherPanel = document.querySelector(`[data-limit-module="${otherName}"]`);
        const isSelected = willOpen && otherButton === button;
        otherButton.classList.toggle("is-active", isSelected);
        otherButton.setAttribute("aria-expanded", String(isSelected));
        if (otherPanel) {
          otherPanel.dataset.limitOpen = String(isSelected);
          otherPanel.hidden = !isSelected;
        }
      });
      if (willOpen) {
        setActiveView("limits");
        panel.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    });
  });

  document.getElementById("open-limits-panel")?.addEventListener("click", () => {
    // Close wallet forms when switching to the Limits page.
    walletPanel?.classList.add("wallet-form-collapsed");
    transferPanel?.classList.add("wallet-transfer-collapsed");
    if (walletToggle) { walletToggle.textContent = "+ Add Wallet"; walletToggle.classList.remove("is-active"); walletToggle.setAttribute("aria-expanded", "false"); }
    if (transferToggle) { transferToggle.textContent = "↔ Wallet Transfer"; transferToggle.classList.remove("is-active"); transferToggle.setAttribute("aria-expanded", "false"); }
    setActiveView("limits");
    document.querySelectorAll("[data-toggle-limit-module]").forEach((button) => {
      const isCategory = button.dataset.toggleLimitModule === "category-limits";
      button.classList.toggle("is-active", isCategory);
      button.setAttribute("aria-expanded", String(isCategory));
      const panel = document.querySelector(`[data-limit-module="${button.dataset.toggleLimitModule}"]`);
      if (panel) { panel.dataset.limitOpen = String(isCategory); panel.hidden = !isCategory; }
    });
    document.getElementById("category-limits-module")?.scrollIntoView({ behavior: "smooth", block: "start" });
  });
  const bulkToggle = document.getElementById("toggle-bulk-actions");
  const bulkToolbar = document.getElementById("bulk-toolbar");
  bulkToggle?.addEventListener("click", () => {
    if (!bulkToolbar) return;
    bulkToolbar.hidden = !bulkToolbar.hidden;
    bulkToggle.setAttribute("aria-expanded", String(!bulkToolbar.hidden));
    bulkToggle.classList.toggle("is-open", !bulkToolbar.hidden);
    bulkToggle.innerHTML = bulkToolbar.hidden
      ? `<span aria-hidden="true">☑</span> Bulk actions <span id="bulk-toggle-count" class="bulk-toggle-count">${window.state.selectedTransactionIds.size}</span>`
      : `<span aria-hidden="true">×</span> Hide actions <span id="bulk-toggle-count" class="bulk-toggle-count">${window.state.selectedTransactionIds.size}</span>`;
  });

  const filterToggle = document.getElementById("toggle-filters");
  const filterFields = document.getElementById("history-filter-fields");
  filterToggle?.addEventListener("click", () => {
    if (!filterFields) return;
    filterFields.hidden = !filterFields.hidden;
    filterToggle.setAttribute("aria-expanded", String(!filterFields.hidden));
    filterToggle.innerHTML = filterFields.hidden ? '<span aria-hidden="true">☷</span> Filters' : '<span aria-hidden="true">×</span> Hide filters';
  });

  const fab = document.getElementById("floating-add-transaction");
  fab?.addEventListener("click", () => {
    setActiveView("transactions");
    const panel = document.getElementById("new-transaction-panel");
    panel?.scrollIntoView({ behavior: "smooth", block: "start" });
    document.getElementById("amt")?.focus({ preventScroll: true });
  });

  const form = document.getElementById("exp-form");
  form?.addEventListener("submit", () => {
    window.setTimeout(() => {
      if (form.checkValidity()) {
        document.getElementById("new-transaction-panel")?.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    }, 50);
  });

  document.getElementById("retry-sync-btn")?.addEventListener("click", async () => {
    const button = document.getElementById("retry-sync-btn");
    if (!navigator.onLine) { alert("You are offline. Finora will sync when internet returns."); return; }
    if (!cloudUser) { alert("Sign in with Google to synchronize your data."); await signInWithGoogle(); return; }
    if (button) { button.disabled = true; button.textContent = "Syncing…"; }
    try {
      await handleCloudLogin(cloudUser);
      if (button) button.textContent = "Retry sync";
    } finally {
      if (button) button.disabled = false;
    }
  });
  document.getElementById("submit-wallet-transfer")?.addEventListener("click", performWalletTransfer);
  document.getElementById("restore-backup-file")?.addEventListener("change", restoreFinoraBackup);

  const welcome = document.getElementById("first-visit-prompt");
  document.getElementById("welcome-guest")?.addEventListener("click", () => {
    localStorage.setItem("finoraWelcomeChoice", "guest");
    if (welcome) welcome.hidden = true;
  });
  document.getElementById("welcome-signin")?.addEventListener("click", async () => {
    await signInWithGoogle();
    if (firebaseAuth?.currentUser) {
      localStorage.setItem("finoraWelcomeChoice", "signed-in");
      if (welcome) welcome.hidden = true;
    }
  });

  document.getElementById("report-email")?.addEventListener("change", () => {
    const email = document.getElementById("report-email")?.value?.trim() || "";
    if (email) window.saveReportEmail();
  });
}

function safeJSONParse(value, fallback) {
  try {
    const parsed = JSON.parse(value);
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

function getDataPayload() {
  return {
    version: 3,
    income: window.state.income,
    goal: window.state.goal,
    currency: window.state.currency,
    categoryCaps: window.state.categoryCaps,
    expenses: window.state.expenses,
    wallets: window.state.wallets,
    transfers: window.state.transfers || [],
    budgetRating: window.state.budgetRating,
    selectedWalletId: window.state.selectedWalletId,
    selectedIncomeWalletId: window.state.selectedIncomeWalletId,
    activeView: window.state.activeView,
  };
}

function applyDataPayload(payload = {}) {
  window.state.income = Number(payload.income) || 0;
  window.state.goal = Number(payload.goal) || 0;
  window.state.currency =
    payload.currency && currencySymbols[payload.currency]
      ? payload.currency
      : "INR";
  window.state.categoryCaps =
    payload.categoryCaps && typeof payload.categoryCaps === "object"
      ? payload.categoryCaps
      : {};
  window.state.wallets = normalizeWallets(payload.wallets || []);
  window.state.transfers = Array.isArray(payload.transfers) ? payload.transfers : [];
  ensureDefaultWallet();
  window.state.expenses = normalizeExpenses(payload.expenses || []);
  window.state.budgetRating =
    Number(payload.budgetRating) || calculateBudgetRating();
  window.state.selectedWalletId = payload.selectedWalletId || "";
  window.state.selectedIncomeWalletId = payload.selectedIncomeWalletId || "";
  window.state.activeView = payload.activeView || "dashboard";
}

function openAppDatabase() {
  if (!("indexedDB" in window)) return Promise.resolve(null);
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(IDB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(IDB_STORE))
        db.createObjectStore(IDB_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return dbPromise;
}

async function idbGet(key) {
  const db = await openAppDatabase();
  if (!db) return null;
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readonly");
    const request = tx.objectStore(IDB_STORE).get(key);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
}

async function idbSet(key, value) {
  const db = await openAppDatabase();
  if (!db) return;
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readwrite");
    tx.objectStore(IDB_STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function hydrateFromIndexedDB() {
  if (encryptedMode) return;
  try {
    const payload = await idbGet(IDB_STATE_KEY);
    if (payload?.version) applyDataPayload(payload);
  } catch (error) {
    console.warn(
      "IndexedDB hydrate failed; localStorage fallback used:",
      error,
    );
  }
}

// function initializeWorker() {
//   if (!window.Worker) return;
//   try {
//     appWorker = new Worker("app-worker.js");
//   } catch (error) {
//     console.warn("Worker unavailable:", error);
//   }
// }

// function registerServiceWorker() {
//   if (!("serviceWorker" in navigator) || location.protocol === "file:") return;
//   navigator.serviceWorker.register("sw.js").catch((error) => {
//     console.warn("Service worker registration failed:", error);
//   });
// }

async function initializeStorage() {
  const vault = localStorage.getItem(VAULT_KEY);
  if (!vault) return;

  const passphrase = prompt(
    "Encrypted budget data found. Enter your passphrase to unlock it.",
  );
  if (!passphrase) {
    alert(
      "Encrypted data is locked. The app will open with an empty session until you reload and unlock.",
    );
    applyDataPayload({});
    return;
  }

  try {
    encryptionKey = await deriveEncryptionKey(
      passphrase,
      JSON.parse(vault).salt,
    );
    applyDataPayload(await decryptVault(vault, encryptionKey));
    encryptedMode = true;
  } catch (error) {
    console.error("Unable to unlock encrypted storage:", error);
    alert("Wrong passphrase or corrupted vault. Reload and try again.");
    applyDataPayload({});
  }
}

function initializeTheme() {
  const savedTheme = localStorage.getItem("theme");
  if (savedTheme === "dark" || savedTheme === "light") {
    document.body.dataset.theme = savedTheme;
    updateThemeButton();
    return;
  }

  const systemPrefersDark = window.matchMedia?.("(prefers-color-scheme: dark)");
  document.body.dataset.theme = systemPrefersDark?.matches ? "dark" : "light";
  updateThemeButton();
  systemPrefersDark?.addEventListener?.("change", (event) => {
    if (!localStorage.getItem("theme")) {
      document.body.dataset.theme = event.matches ? "dark" : "light";
      updateThemeButton();
    }
  });
}

function initializeNavigation() {
  const savedView = ["dashboard", "transactions", "limits", "tools", "about"].includes(
    window.state.activeView,
  )
    ? window.state.activeView
    : "dashboard";

  document.querySelectorAll("[data-view-target]").forEach((button) => {
    button.addEventListener("click", () =>
      setActiveView(button.dataset.viewTarget),
    );
  });

  setActiveView(savedView, false);
}

function setActiveView(view, shouldSave = true) {
  const nextView = ["dashboard", "transactions", "limits", "tools", "about"].includes(
    view,
  )
    ? view
    : "dashboard";
  window.state.activeView = nextView;
  document.body.dataset.activeView = nextView;
  window.closeMobileMenu?.();

  document.querySelectorAll("[data-view-target]").forEach((button) => {
    const isActive = button.dataset.viewTarget === nextView;
    button.classList.toggle("active", isActive);
    button.setAttribute("aria-current", isActive ? "page" : "false");
  });

  document.querySelectorAll(".view-module, .view-page").forEach((module) => {
    const wrongView = module.dataset.view !== nextView;
    const closedLimitModule = module.dataset.limitModule && module.dataset.limitOpen !== "true";
    module.hidden = Boolean(wrongView || closedLimitModule);
  });

  document.querySelectorAll(".side-col, .content-col").forEach((column) => {
    const hasVisibleModule = Array.from(
      column.querySelectorAll(".view-module"),
    ).some((module) => !module.hidden);
    column.hidden = !hasVisibleModule;
  });

  if (shouldSave) {
    localStorage.setItem("activeView", nextView);
    persistData().catch((error) =>
      console.warn("Active view persistence failed:", error),
    );
  }
  if (nextView === "dashboard") {
    requestAnimationFrame(() => {
      requestAnimationFrame(renderAdvancedCharts);
    });
    renderSpendingHeatmap();
  }
  const fab = document.getElementById("floating-add-transaction");
  if (fab) fab.hidden = false;
}

function updateThemeButton() {
  const button = document.getElementById("theme-toggle");
  if (!button) return;
  const isDark = document.body.dataset.theme === "dark";
  button.textContent = isDark ? "\u2600\ufe0f" : "\ud83c\udf19";
  button.title = isDark ? "Switch to light mode" : "Switch to dark mode";
  button.setAttribute("aria-label", button.title);
}

function bindEnterSubmit() {
  ["amt", "note", "custom-cat"].forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      document.querySelector('#exp-form button[type="submit"]')?.click();
    });
  });

  document.getElementById("cap-val")?.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    window.setCategoryCap();
  });
}

function bindVoiceButton() {
  ["voice-btn", "transaction-voice-btn"].forEach((id) => {
    document.getElementById(id)?.addEventListener("click", (event) => {
      event.preventDefault();
      window.startVoiceInput();
    });
  });
}

function bindWalletSelectors() {
  bindWalletSelectPersistence("wallet", "transaction");
  bindWalletSelectPersistence("income-wallet", "income");
}

function bindWalletSelectPersistence(elementId, type) {
  const select = document.getElementById(elementId);
  if (!select) return;

  ["pointerdown", "focus", "input", "change"].forEach((eventName) => {
    select.addEventListener(eventName, () => {
      persistWalletSelection(type, select.value);
    });
  });
}

function persistWalletSelection(type, walletId) {
  if (
    !walletId ||
    !window.state.wallets.some((wallet) => wallet.id === walletId)
  )
    return;
  if (type === "income") {
    window.state.selectedIncomeWalletId = walletId;
  } else {
    window.state.selectedWalletId = walletId;
  }
  saveToLocal();
}

function persistActiveWalletSelections() {
  const walletSelect = document.getElementById("wallet");
  const incomeWalletSelect = document.getElementById("income-wallet");

  if (!window.state.selectedWalletId && walletSelect?.value) {
    window.state.selectedWalletId = walletSelect.value;
  }

  if (!window.state.selectedIncomeWalletId && incomeWalletSelect?.value) {
    window.state.selectedIncomeWalletId = incomeWalletSelect.value;
  }

  if (window.state.selectedWalletId || window.state.selectedIncomeWalletId)
    saveToLocal();
}

function getCurrencyMeta() {
  const currency = window.state.currency || "INR";
  return {
    currency,
    symbol: currencySymbols[currency] || "\u20b9",
    rate: window.state.exchangeRates[currency] || fallbackRates[currency] || 1,
  };
}

function formatMoney(value, digits = 2) {
  const { symbol, rate } = getCurrencyMeta();
  const amount = (Number(value) || 0) * rate;
  return `${symbol}${amount.toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })}`;
}

function saveToLocal() {
  persistData()
    .then(() => {
      markLocalUpdated();
      queueCloudSync();
    })
    .catch((error) => {
      console.error("Storage save failed:", error);
      alert("Could not save data locally. Check browser storage permissions.");
    });
}

async function persistData(options = {}) {
  if (encryptedMode && encryptionKey) {
    localStorage.setItem(
      VAULT_KEY,
      await encryptVault(getDataPayload(), encryptionKey),
    );
    STORAGE_KEYS.forEach((key) => localStorage.removeItem(key));
    await idbSet(IDB_STATE_KEY, {
      encrypted: true,
      updatedAt: new Date().toISOString(),
    }).catch((error) =>
      console.warn("IndexedDB encrypted marker failed:", error),
    );
    updateSecurityStatus();
    return;
  }

  const payload = getDataPayload();
  await idbSet(IDB_STATE_KEY, payload).catch((error) => {
    console.warn(
      "IndexedDB save failed; localStorage fallback remains active:",
      error,
    );
  });
  localStorage.setItem("expenses", JSON.stringify(window.state.expenses));
  localStorage.setItem("income", String(window.state.income));
  localStorage.setItem("goal", String(window.state.goal));
  localStorage.setItem(
    "categoryCaps",
    JSON.stringify(window.state.categoryCaps),
  );
  localStorage.setItem("currency", window.state.currency);
  localStorage.setItem("wallets", JSON.stringify(window.state.wallets));
  localStorage.setItem("finoraTransfers", JSON.stringify(window.state.transfers || []));
  localStorage.setItem("budgetRating", String(window.state.budgetRating));
  localStorage.setItem("selectedWalletId", window.state.selectedWalletId || "");
  localStorage.setItem(
    "selectedIncomeWalletId",
    window.state.selectedIncomeWalletId || "",
  );
  localStorage.setItem("activeView", window.state.activeView || "dashboard");
  updateSecurityStatus();
}

function updateSecurityStatus() {
  const securityStatus = document.getElementById("security-status");
  if (securityStatus) {
    securityStatus.innerText = encryptedMode
      ? "Storage: Encrypted Web Crypto vault"
      : "Storage: Plain localStorage";
  }
}

function bytesToBase64(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)));
}

function base64ToBytes(value) {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

async function deriveEncryptionKey(
  passphrase,
  saltBase64 = bytesToBase64(crypto.getRandomValues(new Uint8Array(16))),
) {
  encryptionSalt = saltBase64;
  const passphraseBytes = new TextEncoder().encode(passphrase);
  const baseKey = await crypto.subtle.importKey(
    "raw",
    passphraseBytes,
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  const salt = base64ToBytes(saltBase64);
  const key = await crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: 150000, hash: "SHA-256" },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
  return key;
}

async function encryptVault(payload, key) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(JSON.stringify(payload));
  const cipherText = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    encoded,
  );
  return JSON.stringify({
    salt: encryptionSalt,
    iv: bytesToBase64(iv),
    data: bytesToBase64(cipherText),
  });
}

async function decryptVault(vaultText, key) {
  const vault = JSON.parse(vaultText);
  const plainBuffer = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBytes(vault.iv) },
    key,
    base64ToBytes(vault.data),
  );
  return JSON.parse(new TextDecoder().decode(plainBuffer));
}

function updateUINotes() {
  const incomeInput = document.getElementById("inc-val");
  const goalInput = document.getElementById("save-val");
  if (incomeInput) incomeInput.value = window.state.income || "";
  if (goalInput) goalInput.value = window.state.goal || "";

  const noteInc = document.getElementById("note-inc");
  const noteGoal = document.getElementById("note-goal");
  if (noteInc) noteInc.innerText = formatMoney(window.state.income);
  if (noteGoal) noteGoal.innerText = formatMoney(window.state.goal);
}

function resetDateFilters() {
  const start = document.getElementById("filter-start");
  const end = document.getElementById("filter-end");
  if (!start || !end) return;

  const today = new Date();
  const oneMonthAgo = new Date(today);
  oneMonthAgo.setMonth(today.getMonth() - 1);
  start.value = oneMonthAgo.toISOString().split("T")[0];
  end.value = today.toISOString().split("T")[0];
}

// Schedule a daily check for finance period end notification
function scheduleFinancePeriodReminder(endDate) {
  localStorage.setItem("financeTo", endDate);
}

function scheduleWalletPeriodReminder(walletName, endDate) {
  // Store wallet end date so checkWalletPeriods() can pick it up on next load
  const key = `walletPeriod:${walletName}`;
  localStorage.setItem(key, endDate);
}

function checkFinancePeriodStatus() {
  const savedTo = localStorage.getItem("financeTo") || "";
  const savedFrom = localStorage.getItem("financeFrom") || "";
  if (!savedTo) return;

  const today = new Date().toISOString().split("T")[0];
  const todayNotifKey = `financeEndNotif:${savedTo}`;

  if (today === savedTo) {
    // Notify on the exact end date (once per day)
    if (!localStorage.getItem(todayNotifKey)) {
      localStorage.setItem(todayNotifKey, "shown");
      setTimeout(() => {
        alert(
          `📅 Today is the last day of your financial period (${savedFrom} → ${savedTo}).\n\nPlease update your:\n• Income\n• Saving target\n• Wallet balances\n• Category limits\n\nGo to the "Limits" tab to set a new period.`,
        );
      }, 1500);
    }
    return;
  }

  if (today > savedTo) {
    // Period already ended, notify once
    if (!localStorage.getItem(todayNotifKey)) {
      localStorage.setItem(todayNotifKey, "shown");
      setTimeout(() => {
        alert(
          `⏰ Your financial period ended on ${savedTo}.\n\nPlease update your Income, Saving target, Wallet balances, and Category limits under the "Limits" tab to start a new period.`,
        );
      }, 1200);
    }
    return;
  }

  // Warn 3 days before end
  const daysLeft = Math.ceil(
    (new Date(savedTo) - new Date(today)) / (1000 * 60 * 60 * 24),
  );
  if (daysLeft <= 3) {
    const warnKey = `financeWarn:${savedTo}:${today}`;
    if (!localStorage.getItem(warnKey)) {
      localStorage.setItem(warnKey, "shown");
      setTimeout(() => {
        alert(
          `⚠️ Your financial period ends in ${daysLeft} day(s) on ${savedTo}.\n\nBe ready to update your Income, Wallets, and Goals.`,
        );
      }, 1500);
    }
  }
}

function checkWalletPeriods() {
  const today = new Date().toISOString().split("T")[0];
  window.state.wallets.forEach((wallet) => {
    if (!wallet.to) return;
    const endDate = wallet.to;
    const notifKey = `walletEndNotif:${wallet.id}:${endDate}`;
    if (localStorage.getItem(notifKey)) return;

    const daysLeft = Math.ceil(
      (new Date(endDate) - new Date(today)) / (1000 * 60 * 60 * 24),
    );

    if (today === endDate) {
      localStorage.setItem(notifKey, "shown");
      setTimeout(() => {
        alert(
          `📅 Wallet "${wallet.name}" period ends today (${endDate}).\n\nPlease update its balance in the Transactions → Wallets section.`,
        );
      }, 2000);
    } else if (today > endDate) {
      localStorage.setItem(notifKey, "shown");
      setTimeout(() => {
        alert(
          `⏰ Wallet "${wallet.name}" period ended on ${endDate}.\n\nPlease update its balance.`,
        );
      }, 2000);
    } else if (daysLeft <= 3) {
      const warnKey = `walletWarn:${wallet.id}:${today}`;
      if (!localStorage.getItem(warnKey)) {
        localStorage.setItem(warnKey, "shown");
        setTimeout(() => {
          alert(
            `⚠️ Wallet "${wallet.name}" period ends in ${daysLeft} day(s) on ${endDate}. Be ready to update it.`,
          );
        }, 2000);
      }
    }
  });
}

window.updateFinance = () => {
  window.state.income = Math.max(
    parseFloat(document.getElementById("inc-val")?.value) || 0,
    0,
  );
  window.state.goal = Math.max(
    parseFloat(document.getElementById("save-val")?.value) || 0,
    0,
  );

  // Save period dates
  const fromVal = document.getElementById("finance-from")?.value || "";
  const toVal = document.getElementById("finance-to")?.value || "";

  if (fromVal && toVal && fromVal > toVal) {
    alert("⚠️ Period Start date must be before Period End date.");
    return;
  }

  localStorage.setItem("financeFrom", fromVal);
  localStorage.setItem("financeTo", toVal);

  if (toVal) {
    scheduleFinancePeriodReminder(toVal);
  }

  saveToLocal();
  updateUINotes();
  refresh();
};

function ensureDefaultWallet() {
  if (!window.state.wallets.length) {
    window.state.wallets = [
      {
        id: "wallet-bank",
        name: "Bank",
        balance: Number(window.state.income) || 0,
      },
      { id: "wallet-cash", name: "Cash", balance: 0 },
      { id: "wallet-digital", name: "Digital Wallet", balance: 0 },
    ];
    return;
  }

  if (
    !window.state.wallets.some(
      (wallet) =>
        wallet.id === "wallet-bank" || wallet.name.toLowerCase() === "bank",
    )
  ) {
    window.state.wallets.unshift({
      id: "wallet-bank",
      name: "Bank",
      balance: Number(window.state.income) || 0,
    });
  }
}

function getDefaultWalletId() {
  return (
    window.state.wallets.find((wallet) => wallet.id === "wallet-bank")?.id ||
    window.state.wallets.find((wallet) => wallet.name.toLowerCase() === "bank")
      ?.id ||
    window.state.wallets[0]?.id ||
    "wallet-bank"
  );
}

function getSelectedWalletId(type = "transaction") {
  const storedId =
    type === "income"
      ? window.state.selectedIncomeWalletId
      : window.state.selectedWalletId;
  const exists = window.state.wallets.some((wallet) => wallet.id === storedId);
  return exists ? storedId : getDefaultWalletId();
}

function normalizeWallets(items) {
  return items
    .map((wallet, index) => ({
      id: String(wallet.id || `wallet-${Date.now()}-${index}`),
      name: cleanTextInput(wallet.name, "Wallet"),
      balance: Number(wallet.balance) || 0,
      ...(wallet.from && { from: wallet.from }),
      ...(wallet.to && { to: wallet.to }),
    }))
    .filter((wallet) => wallet.name);
}

function getWalletBalance(wallet) {
  const spent = window.state.expenses
    .filter(
      (expense) => (expense.walletId || getDefaultWalletId()) === wallet.id,
    )
    .reduce((sum, expense) => sum + expense.amt, 0);
  return wallet.balance - spent;
}

// 1. LOCATE AND UPDATE YOUR EXISTING renderWallets FUNCTION TO INCLUDE THE EDIT BUTTON
function renderWallets() {
  const walletSelect = document.getElementById("wallet");
  const incomeWalletSelect = document.getElementById("income-wallet");
  const walletList = document.getElementById("wallet-list");

  if (walletSelect) walletSelect.innerHTML = "";
  if (incomeWalletSelect) incomeWalletSelect.innerHTML = "";
  const transferFrom = document.getElementById("transfer-from");
  const transferTo = document.getElementById("transfer-to");
  if (transferFrom) transferFrom.innerHTML = "";
  if (transferTo) transferTo.innerHTML = "";
  if (walletList) walletList.innerHTML = "";
  const walletCount = document.getElementById("wallet-count-badge");
  if (walletCount) walletCount.textContent = `${window.state.wallets.length} wallet${window.state.wallets.length === 1 ? "" : "s"}`;

  const { symbol } = getCurrencyMeta();

  window.state.wallets.forEach((wallet) => {
    // Populate form dropdown selects
    [walletSelect, incomeWalletSelect].forEach((select) => {
      if (!select) return;
      const option = document.createElement("option");
      option.value = wallet.id;
      option.textContent = `${wallet.name} (${formatMoney(getWalletBalance(wallet), 0)})`;
      if (
        select === walletSelect &&
        wallet.id === window.state.selectedWalletId
      )
        option.selected = true;
      if (
        select === incomeWalletSelect &&
        wallet.id === window.state.selectedIncomeWalletId
      )
        option.selected = true;
      select.appendChild(option);
    });
    [transferFrom, transferTo].forEach((select) => {
      if (!select) return;
      const option = document.createElement("option");
      option.value = wallet.id;
      option.textContent = `${wallet.name} (${formatMoney(getWalletBalance(wallet), 2)})`;
      select.appendChild(option);
    });

    // Populate the Wallet Settings UI Manager list
    if (walletList) {
      const li = document.createElement("li");
      li.className = "wallet-item";

      const rawBalance = getWalletBalance(wallet);

      li.innerHTML = `
  <div class="wallet-info-text">
    <strong class="wallet-name">${escapeHTML(wallet.name)}</strong>
    <span class="wallet-balance">${formatMoney(rawBalance)}</span>
    ${wallet.from || wallet.to ? `<span class="wallet-period">📅 ${wallet.from || "—"} → ${wallet.to || "—"}</span>` : '<span class="wallet-period no-period">No date range set</span>'}
  </div>
  <div class="wallet-actions">
    <button class="btn-action-edit" onclick="window.updateWalletAmount('${wallet.id}')" title="Edit Wallet Balance">
      ✏️ <span>Edit</span>
    </button>
    <button class="btn-action-delete" onclick="window.removeWallet('${wallet.id}')" title="Delete Wallet">
      ❌
    </button>
  </div>
`;
      walletList.appendChild(li);
    }
  });
  if (transferFrom && window.state.wallets.length) transferFrom.selectedIndex = 0;
  if (transferTo && window.state.wallets.length > 1) transferTo.selectedIndex = 1;
  renderTransferHistory();
}

// Wallet transfers move balances without being recorded as income or expense.
function performWalletTransfer() {
  const fromId = document.getElementById("transfer-from")?.value;
  const toId = document.getElementById("transfer-to")?.value;
  const amount = Number(document.getElementById("transfer-amount")?.value);
  const date = document.getElementById("transfer-date")?.value || new Date().toISOString().slice(0, 10);
  if (!fromId || !toId || fromId === toId) { alert("Choose two different wallets."); return; }
  if (!Number.isFinite(amount) || amount <= 0) { alert("Enter a transfer amount greater than zero."); return; }
  const from = window.state.wallets.find((wallet) => wallet.id === fromId);
  const to = window.state.wallets.find((wallet) => wallet.id === toId);
  if (!from || !to) { alert("Please select valid wallets."); return; }
  const available = getWalletBalance(from);
  if (amount > available) { alert(`Insufficient balance. Available in ${from.name}: ${formatMoney(available)}.`); return; }
  if (!confirm(`Transfer ${formatMoney(amount)} from ${from.name} to ${to.name}?`)) return;
  from.balance -= amount;
  to.balance += amount;
  window.state.transfers = window.state.transfers || [];
  window.state.transfers.unshift({ id: Date.now(), fromId, toId, amount, date });
  document.getElementById("transfer-amount").value = "";
  saveToLocal(); renderWallets(); refresh();
}
window.performWalletTransfer = performWalletTransfer;

function renderTransferHistory() {
  const holder = document.getElementById("transfer-history");
  if (!holder) return;
  const transfers = (window.state.transfers || []).slice(0, 5);
  if (!transfers.length) { holder.innerHTML = '<p class="empty-note">No transfers yet.</p>'; return; }
  holder.innerHTML = '<h4>Recent transfers</h4>' + transfers.map((transfer) => {
    const from = window.state.wallets.find((wallet) => wallet.id === transfer.fromId)?.name || "Wallet";
    const to = window.state.wallets.find((wallet) => wallet.id === transfer.toId)?.name || "Wallet";
    return `<div class="transfer-history-row"><span>${escapeHTML(from)} → ${escapeHTML(to)}<small>${escapeHTML(transfer.date || "")}</small></span><strong>${formatMoney(transfer.amount)}</strong></div>`;
  }).join("");
}

// 2. ADD THIS NEW FUNCTION RIGHT BELOW RENDERWALLETS
window.updateWalletAmount = (id) => {
  const wallet = window.state.wallets.find((w) => w.id === id);
  if (!wallet) {
    alert("Wallet not found.");
    return;
  }

  const spent = window.state.expenses
    .filter((e) => (e.walletId || "wallet-bank") === id)
    .reduce((sum, e) => sum + e.amt, 0);

  const currentAvailable = wallet.balance - spent;

  const input = prompt(
    `Enter new current balance for "${wallet.name}":`,
    currentAvailable.toFixed(2),
  );
  if (input === null) return;

  const newAvailable = parseFloat(input);
  if (isNaN(newAvailable) || newAvailable < 0) {
    alert("Please enter a valid positive number.");
    return;
  }

  wallet.balance = newAvailable + spent;

  // Offer date range update
  const currentFrom = wallet.from || "";
  const currentTo = wallet.to || "";
  const updateDates = confirm(
    `Would you also like to update the date range for "${wallet.name}"?\n\nCurrent range: ${currentFrom || "not set"} → ${currentTo || "not set"}`,
  );
  if (updateDates) {
    const newFrom = prompt(
      "Valid From (YYYY-MM-DD), or leave blank:",
      currentFrom,
    );
    if (newFrom !== null) {
      wallet.from = newFrom.trim() || undefined;
    }
    const newTo = prompt("Valid To (YYYY-MM-DD), or leave blank:", currentTo);
    if (newTo !== null) {
      wallet.to = newTo.trim() || undefined;
      if (wallet.to) scheduleWalletPeriodReminder(wallet.name, wallet.to);
    }
    if (!wallet.from && !wallet.to) {
      const confirmed = confirm(
        `⚠️ No date range set for "${wallet.name}".\n\nYou won't be notified when to update this wallet. Continue?`,
      );
      if (!confirmed) return;
    }
  }

  if (typeof persistCurrentWalletSelectionsBeforeRender === "function") {
    persistCurrentWalletSelectionsBeforeRender();
  }
  saveToLocal();
  if (typeof refresh === "function") {
    refresh();
  } else {
    renderWallets();
  }
  updateTopCounters();
  alert(`"${wallet.name}" updated successfully!`);
};

function updateTopCounters() {
  // Recalculate available pool totals across all combined wallets
  const totalWalletPool = window.state.wallets.reduce((sum, wallet) => {
    const spent = window.state.expenses
      .filter((e) => (e.walletId || "wallet-bank") === wallet.id)
      .reduce((s, e) => s + e.amt, 0);
    return sum + (wallet.balance - spent);
  }, 0);

  // Targets the layout total-balance element container
  const totalBalanceElement =
    document.getElementById("total-balance") ||
    document.querySelector(".stat-card .balance-value") ||
    document.getElementById("balance");
  if (totalBalanceElement) {
    totalBalanceElement.textContent = formatMoney(totalWalletPool);
  }

  // Fallback to update canvas view models if active
  if (
    typeof renderAdvancedCharts === "function" &&
    window.state.activeView === "dashboard"
  ) {
    renderAdvancedCharts();
  }
}

function persistCurrentWalletSelectionsBeforeRender() {
  const walletValue = document.getElementById("wallet")?.value;
  const incomeWalletValue = document.getElementById("income-wallet")?.value;

  if (
    walletValue &&
    window.state.wallets.some((wallet) => wallet.id === walletValue)
  ) {
    window.state.selectedWalletId = walletValue;
  }

  if (
    incomeWalletValue &&
    window.state.wallets.some((wallet) => wallet.id === incomeWalletValue)
  ) {
    window.state.selectedIncomeWalletId = incomeWalletValue;
  }
}

function createWalletListItem(wallet) {
  const item = document.createElement("div");
  item.className = "wallet-item";

  const details = document.createElement("div");
  const name = document.createElement("b");
  name.textContent = wallet.name;
  const balance = document.createElement("span");
  balance.textContent = `${formatMoney(getWalletBalance(wallet))} available`;
  details.appendChild(name);
  details.appendChild(balance);

  const button = document.createElement("button");
  button.type = "button";
  button.className = "link-danger";
  button.dataset.walletId = wallet.id;
  button.textContent = "Remove";

  item.appendChild(details);
  item.appendChild(button);
  return item;
}

window.addWallet = () => {
  persistActiveWalletSelections();

  const name = cleanTextInput(document.getElementById("wallet-name")?.value);
  const balance =
    parseFloat(document.getElementById("wallet-balance")?.value) || 0;
  if (!name) {
    alert("Enter a wallet name.");
    return;
  }

  const fromVal = document.getElementById("wallet-from")?.value || "";
  const toVal = document.getElementById("wallet-to")?.value || "";

  // Wallet date ranges are optional. Validate only when both dates are provided.
  if (fromVal && toVal && fromVal > toVal) {
    alert("Valid From date must be before Valid To date.");
    return;
  }

  const newWallet = {
    id: `wallet-${Date.now()}`,
    name,
    balance: Math.max(balance, 0),
    ...(fromVal && { from: fromVal }),
    ...(toVal && { to: toVal }),
  };

  window.state.wallets.push(newWallet);
  localStorage.setItem("finoraWalletSetupComplete", "true");

  // Schedule notification for wallet end date
  if (toVal) {
    scheduleWalletPeriodReminder(name, toVal);
  }

  document.getElementById("wallet-name").value = "";
  document.getElementById("wallet-balance").value = "";
  if (document.getElementById("wallet-from"))
    document.getElementById("wallet-from").value = "";
  if (document.getElementById("wallet-to"))
    document.getElementById("wallet-to").value = "";
  saveToLocal();
  renderWallets();
};

window.removeWallet = (walletId) => {
  if (window.state.wallets.length <= 1) {
    alert("Keep at least one wallet.");
    return;
  }
  const hasTransactions = window.state.expenses.some(
    (expense) => (expense.walletId || getDefaultWalletId()) === walletId,
  );
  if (hasTransactions) {
    alert(
      "This wallet has transactions. Delete or reassign them before removing it.",
    );
    return;
  }
  window.state.wallets = window.state.wallets.filter(
    (wallet) => wallet.id !== walletId,
  );
  if (window.state.selectedWalletId === walletId)
    window.state.selectedWalletId = getDefaultWalletId();
  if (window.state.selectedIncomeWalletId === walletId)
    window.state.selectedIncomeWalletId = getDefaultWalletId();
  saveToLocal();
  renderWallets();
};

window.changeCurrency = () => {
  const selector = document.getElementById("currency-select");
  window.state.currency = selector?.value || "INR";
  localStorage.setItem("currency", window.state.currency);
  updateCurrencyUI();
  updateUINotes();
  refresh();
};

function updateCurrencyUI() {
  const selector = document.getElementById("currency-select");
  if (selector) selector.value = window.state.currency;

  document.querySelectorAll(".currency-symbol").forEach((el) => {
    el.textContent = getCurrencyMeta().symbol;
  });
}

window.editTransaction = (id) => {
  const transaction = window.state.expenses.find((expense) => String(expense.id) === String(id));
  if (!transaction) { alert("Transaction not found. Refresh the history and try again."); return; }
  const modal = document.getElementById("edit-transaction-modal");
  const form = document.getElementById("edit-transaction-form");
  if (!modal || !form) {
    // Safe fallback if the edit dialog is missing from a customized copy.
    const amountText = prompt("Amount:", String(transaction.amt));
    if (amountText === null) return;
    const amount = Number(amountText);
    if (!Number.isFinite(amount) || amount <= 0) { alert("Enter a valid amount greater than zero."); return; }
    transaction.amt = amount;
    saveToLocal(); refresh(); renderWallets();
    return;
  }
  form.dataset.transactionId = String(transaction.id);
  document.getElementById("edit-transaction-amount").value = String(transaction.amt ?? "");
  document.getElementById("edit-transaction-note").value = transaction.note || "";
  document.getElementById("edit-transaction-date").value = /^\d{4}-\d{2}-\d{2}$/.test(transaction.date || "") ? transaction.date : new Date().toISOString().slice(0, 10);
  document.getElementById("edit-transaction-category").value = transaction.cat || "Other";
  document.getElementById("edit-transaction-wallet").innerHTML = window.state.wallets.map((wallet) =>
    `<option value="${escapeHTML(String(wallet.id))}">${escapeHTML(wallet.name)} (${escapeHTML(formatMoney(wallet.balance || 0))})</option>`
  ).join("");
  document.getElementById("edit-transaction-wallet").value = String(transaction.walletId || getDefaultWalletId());
  modal.hidden = false;
  document.body.classList.add("modal-open");
  document.getElementById("edit-transaction-amount").focus();
};

function closeEditTransactionModal() {
  const modal = document.getElementById("edit-transaction-modal");
  if (modal) modal.hidden = true;
  document.body.classList.remove("modal-open");
}

function saveEditedTransaction(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const id = form.dataset.transactionId;
  const transaction = window.state.expenses.find((expense) => String(expense.id) === String(id));
  if (!transaction) { alert("This transaction could not be found. Please refresh and try again."); closeEditTransactionModal(); return; }
  const amount = Number(document.getElementById("edit-transaction-amount").value);
  const date = document.getElementById("edit-transaction-date").value;
  const category = document.getElementById("edit-transaction-category").value;
  const walletId = document.getElementById("edit-transaction-wallet").value;
  if (!Number.isFinite(amount) || amount <= 0) { alert("Enter an amount greater than zero."); return; }
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) { alert("Choose a valid transaction date."); return; }
  if (!window.state.wallets.some((wallet) => String(wallet.id) === String(walletId))) { alert("Choose a valid wallet."); return; }
  transaction.amt = amount;
  transaction.note = cleanTextInput(document.getElementById("edit-transaction-note").value, "Expense");
  transaction.date = date;
  transaction.cat = category || "Other";
  transaction.walletId = walletId;
  closeEditTransactionModal();
  saveToLocal();
  refresh();
  renderWallets();
}

window.localDelete = (id) => {
  if (!confirm("Permanently delete this record?")) return;
  window.state.expenses = window.state.expenses.filter(
    (expense) => expense.id !== id,
  );
  window.state.selectedTransactionIds.delete(String(id));
  saveToLocal();
  refresh();
};

window.toggleTransactionSelection = (id, checked) => {
  const key = String(id);
  if (checked) window.state.selectedTransactionIds.add(key);
  else window.state.selectedTransactionIds.delete(key);
  updateBulkToolbar();
};

window.toggleAllTransactions = (checked) => {
  const visibleIds = (window.state.filteredData || [])
    .slice(
      (window.state.currentPage - 1) * window.state.pageSize,
      window.state.currentPage * window.state.pageSize,
    )
    .map((expense) => String(expense.id));
  visibleIds.forEach((id) => {
    if (checked) window.state.selectedTransactionIds.add(id);
    else window.state.selectedTransactionIds.delete(id);
  });
  refresh();
};

function updateBulkToolbar() {
  const count = window.state.selectedTransactionIds.size;
  setText("bulk-count", `${count} selected`);
  const toggleButton = document.getElementById("toggle-bulk-actions");
  const countBadge = document.getElementById("bulk-toggle-count");
  if (countBadge) countBadge.textContent = String(count);
  if (toggleButton) {
    const isOpen = toggleButton.getAttribute("aria-expanded") === "true";
    toggleButton.innerHTML = isOpen
      ? `<span aria-hidden="true">×</span> Hide actions <span id="bulk-toggle-count" class="bulk-toggle-count">${count}</span>`
      : `<span aria-hidden="true">☑</span> Bulk actions <span id="bulk-toggle-count" class="bulk-toggle-count">${count}</span>`;
  }
  const toolbar = document.getElementById("bulk-toolbar");
  if (toolbar) toolbar.classList.toggle("has-selection", count > 0);
  const selectAll = document.getElementById("select-all-transactions");
  if (selectAll) {
    const pageIds = (window.state.filteredData || [])
      .slice(
        (window.state.currentPage - 1) * window.state.pageSize,
        window.state.currentPage * window.state.pageSize,
      )
      .map((expense) => String(expense.id));
    selectAll.checked =
      pageIds.length > 0 &&
      pageIds.every((id) => window.state.selectedTransactionIds.has(id));
  }
}

window.bulkDeleteTransactions = () => {
  const selected = window.state.selectedTransactionIds;
  if (!selected.size) {
    alert("Select at least one transaction.");
    return;
  }
  if (!confirm(`Delete ${selected.size} selected transaction(s)?`)) return;
  window.state.expenses = window.state.expenses.filter(
    (expense) => !selected.has(String(expense.id)),
  );
  selected.clear();
  saveToLocal();
  refresh();
};

window.bulkApplyChanges = () => {
  const selected = window.state.selectedTransactionIds;
  if (!selected.size) {
    alert("Select at least one transaction.");
    return;
  }
  const nextCategory = document.getElementById("bulk-category")?.value;
  const nextWallet = document.getElementById("bulk-wallet")?.value;
  if (!nextCategory && !nextWallet) {
    alert("Choose a category or wallet to apply.");
    return;
  }
  window.state.expenses = window.state.expenses.map((expense) => {
    if (!selected.has(String(expense.id))) return expense;
    return {
      ...expense,
      cat: nextCategory || expense.cat,
      subcat: nextCategory
        ? (subcategoryMap[nextCategory] || subcategoryMap.Other)[0]
        : expense.subcat,
      walletId: nextWallet || expense.walletId,
    };
  });
  selected.clear();
  document.getElementById("bulk-category").value = "";
  document.getElementById("bulk-wallet").value = "";
  saveToLocal();
  refresh();
};

window.setCategoryCap = () => {
  const cat = cleanTextInput(
    document.getElementById("cap-cat")?.value,
    "Other",
  );
  const val = parseFloat(document.getElementById("cap-val")?.value);
  if (!cat || !Number.isFinite(val) || val <= 0) {
    alert("Enter a category and a limit greater than zero.");
    return;
  }

  window.state.categoryCaps[cat] = val;
  saveToLocal();
  refresh();
  document.getElementById("cap-val").value = "";
};

window.removeCategoryCap = (cat) => {
  delete window.state.categoryCaps[cat];
  saveToLocal();
  refresh();
};

function handleCategoryChange(value) {
  const customInput = document.getElementById("custom-cat");
  const subcatInput = document.getElementById("subcat");
  const isOther = value === "Other";

  // custom-cat: shown only for Other (category name)
  if (customInput) {
    customInput.style.display = isOther ? "block" : "none";
    if (!isOther) customInput.value = "";
  }

  // subcat text input: shown only for Other (subcategory label)
  if (subcatInput) {
    subcatInput.style.display = isOther ? "block" : "none";
    if (!isOther) subcatInput.value = "";
  }
}

window.handleCategoryChange = handleCategoryChange;

function populateSubcategoryOptions(category, selectedValue = "") {
  // No-op: subcat is now a plain text input, only for Other
}

function renderCategoryCaps() {
  const capsList = document.getElementById("caps-list");
  if (!capsList) return;
  capsList.innerHTML = "";

  const expensesToProcess = window.state.filteredData || [];
  const spentPerCat = expensesToProcess.reduce((totals, expense) => {
    totals[expense.cat] = (totals[expense.cat] || 0) + expense.amt;
    return totals;
  }, {});

  const entries = Object.entries(window.state.categoryCaps || {});
  if (!entries.length) {
    capsList.innerHTML = '<p class="empty-note">No category limits set.</p>';
    return;
  }

  const fragment = document.createDocumentFragment();
  entries.forEach(([cat, limit]) => {
    const spent = spentPerCat[cat] || 0;
    const percent = limit > 0 ? (spent / limit) * 100 : 0;
    const item = document.createElement("div");
    item.className = `cap-item ${percent >= 100 ? "cap-danger" : percent >= 80 ? "cap-warning" : ""}`;

    const isLocked = window.state.budgetLock && percent >= 100;

    const badge = isLocked
      ? '<span class="cap-badge bg-danger">🔒 LOCKED</span>'
      : percent >= 100
        ? '<span class="cap-badge bg-danger">EXCEEDED</span>'
        : percent >= 80
          ? '<span class="cap-badge bg-warning">WARNING</span>'
          : "";

    item.innerHTML = `
      <div class="cap-header">
        <span>${escapeHTML(cat)} ${badge}</span>
        <span>${formatMoney(spent, 0)} / ${formatMoney(limit, 0)}</span>
      </div>
      <div class="progress-container compact-progress">
        <div class="progress-bar" style="width: ${Math.min(percent, 100)}%; background: ${
          percent >= 100
            ? "var(--danger)"
            : percent >= 80
              ? "var(--warning)"
              : "var(--success)"
        };"></div>
      </div>
      ${
        isLocked
          ? `<button type="button" class="btn-export unfreeze-btn" data-unfreeze-cat="${escapeHTML(cat)}">🔓 Unfreeze — raise limit</button>`
          : ""
      }
      <button type="button" class="link-danger" data-cap-cat="${escapeHTML(cat)}">Remove Limit</button>
    `;
    fragment.appendChild(item);
  });

  capsList.appendChild(fragment);
  capsList.querySelectorAll("[data-cap-cat]").forEach((button) => {
    button.addEventListener("click", () =>
      window.removeCategoryCap(button.dataset.capCat),
    );
  });
  capsList.querySelectorAll("[data-unfreeze-cat]").forEach((button) => {
    button.addEventListener("click", () =>
      window.unfreezeCategory(button.dataset.unfreezeCat),
    );
  });
}

function getRecurringInsight(expense) {
  const txDate = new Date(`${expense.date}T00:00:00`);
  if (Number.isNaN(txDate.getTime())) return { diffDays: 0, alertHtml: "" };

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  let nextBill = new Date(txDate);

  while (nextBill < today) {
    nextBill.setMonth(nextBill.getMonth() + 1);
  }

  const diffDays = Math.ceil((nextBill - today) / (1000 * 60 * 60 * 24));
  let alertHtml = "";
  if (diffDays === 0) {
    alertHtml = '<span class="cap-badge bg-danger">PAY TODAY</span>';
  } else if (diffDays === 1) {
    alertHtml = '<span class="cap-badge bg-warning">DUE TOMORROW</span>';
  } else if (diffDays <= 3) {
    alertHtml = '<span class="cap-badge bg-warning">UPCOMING</span>';
  }

  return { diffDays, alertHtml, nextBill: nextBill.toISOString().slice(0, 10) };
}

function notifyUpcomingRecurringPayments() {
  const dueSoon = window.state.expenses
    .filter((expense) => expense.recurring)
    .map((expense) => ({ expense, insight: getRecurringInsight(expense) }))
    .filter(({ insight }) => insight.diffDays >= 0 && insight.diffDays <= 1);
  if (!dueSoon.length) return;

  const todayKey = new Date().toISOString().slice(0, 10);
  const reminderKey = `recurringReminder:${todayKey}`;
  if (localStorage.getItem(reminderKey)) return;

  localStorage.setItem(reminderKey, "shown");
  const message = dueSoon
    .map(({ expense, insight }) => {
      const when = insight.diffDays === 0 ? "today" : "tomorrow";
      const walletName =
        window.state.wallets.find((wallet) => wallet.id === expense.walletId)
          ?.name || "Bank";
      return `${expense.note || expense.cat}: ${formatMoney(expense.amt)} due ${when} from ${walletName}`;
    })
    .join("\n");

  if (
    typeof Notification !== "undefined" &&
    Notification.permission === "granted"
  ) {
    fireNotification("Recurring Payment Reminder", message);
  } else {
    alert(
      `Recurring payment reminder:\n${message}\n\nPlease enable autopay or pay the recurring amount on time.`,
    );
  }
}

function renderMonthlyComparison() {
  const now = new Date();
  const currentKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const previousDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const previousKey = `${previousDate.getFullYear()}-${String(previousDate.getMonth() + 1).padStart(2, "0")}`;
  const sumFor = (key) => window.state.expenses.filter((expense) => String(expense.date || "").slice(0, 7) === key).reduce((sum, expense) => sum + Number(expense.amt || 0), 0);
  const current = sumFor(currentKey), previous = sumFor(previousKey);
  const currentEl = document.getElementById("comparison-current");
  const previousEl = document.getElementById("comparison-previous");
  const changeEl = document.getElementById("comparison-change");
  const noteEl = document.getElementById("comparison-note");
  const periodEl = document.getElementById("comparison-period");
  if (currentEl) currentEl.textContent = formatMoney(current);
  if (previousEl) previousEl.textContent = formatMoney(previous);
  if (periodEl) periodEl.textContent = now.toLocaleDateString(undefined, { month: "short", year: "numeric" });
  if (changeEl) {
    if (previous <= 0) changeEl.textContent = current > 0 ? "No previous data" : "No change";
    else { const pct = ((current - previous) / previous) * 100; changeEl.textContent = `${pct > 0 ? "+" : ""}${pct.toFixed(1)}%`; changeEl.dataset.trend = pct > 0 ? "up" : pct < 0 ? "down" : "steady"; }
  }
  if (noteEl) {
    if (previous <= 0 && current <= 0) noteEl.textContent = "Add transactions to see your monthly comparison.";
    else if (previous <= 0) noteEl.textContent = "This is your first month with recorded expenses.";
    else if (current > previous) noteEl.textContent = `Spending is ${formatMoney(current - previous)} higher than last month.`;
    else if (current < previous) noteEl.textContent = `Spending is ${formatMoney(previous - current)} lower than last month.`;
    else noteEl.textContent = "Spending matches last month.";
  }
}

function refresh() {
  const list = document.getElementById("list-body");
  renderMonthlyComparison();
  if (!list) return;

  const subBox = document.getElementById("sub-list");
  const pagin = document.getElementById("pagination");
  const startFilter = document.getElementById("filter-start")?.value;
  const endFilter = document.getElementById("filter-end")?.value;
  const searchTerm = document
    .getElementById("search-input")
    ?.value.trim()
    .toLowerCase();

  list.innerHTML = "";
  if (subBox) subBox.innerHTML = "";
  if (pagin) pagin.innerHTML = "";

  window.state.filteredData = window.state.expenses
    .filter((expense) => {
      const afterStart = startFilter ? expense.date >= startFilter : true;
      const beforeEnd = endFilter ? expense.date <= endFilter : true;
      const matchesSearch = searchTerm
        ? `${expense.note || ""} ${expense.cat || ""} ${expense.subcat || ""}`
            .toLowerCase()
            .includes(searchTerm)
        : true;
      return afterStart && beforeEnd && matchesSearch;
    })
    .sort((a, b) => b.id - a.id);

  const totalExp = window.state.filteredData.reduce(
    (sum, expense) => sum + expense.amt,
    0,
  );

  // Balance = sum of all wallet available balances (wallet.balance - that wallet's expenses)
  const totalWalletBalance = window.state.wallets.reduce((sum, wallet) => {
    const walletSpent = window.state.expenses
      .filter((e) => (e.walletId || getDefaultWalletId()) === wallet.id)
      .reduce((s, e) => s + e.amt, 0);
    return sum + Math.max(0, wallet.balance - walletSpent);
  }, 0);
  let fixedAmt = 0;

  const recurringExpenses = window.state.filteredData.filter(
    (expense) => expense.recurring,
  );

  if (subBox) {
    if (!recurringExpenses.length) {
      subBox.innerHTML =
        '<p class="empty-note">No recurring transactions in the selected range.</p>';
    } else {
      recurringExpenses.forEach((expense) => {
        fixedAmt += expense.amt;
        const insight = getRecurringInsight(expense);
        subBox.innerHTML += `
          <div class="subscription-item">
            <div>
              <b>${escapeHTML(expense.note)}</b>
              <span>${escapeHTML(expense.cat)} · ${insight.diffDays} day(s) remaining</span>
            </div>
            <div class="subscription-amount">
              <b>${formatMoney(expense.amt)}</b>
              ${insight.alertHtml}
            </div>
          </div>`;
      });
    }
  }

  const pageCount = Math.max(
    Math.ceil(window.state.filteredData.length / window.state.pageSize),
    1,
  );
  if (window.state.currentPage > pageCount)
    window.state.currentPage = pageCount;

  const startIdx = (window.state.currentPage - 1) * window.state.pageSize;
  const pagedData = window.state.filteredData.slice(
    startIdx,
    startIdx + window.state.pageSize,
  );

  if (!pagedData.length) {
    list.innerHTML = list.innerHTML =
      '<tr><td colspan="7" class="empty-table">No transactions found.</td></tr>';
  } else {
    pagedData.forEach((expense) => {
      const isSelected = window.state.selectedTransactionIds.has(
        String(expense.id),
      );
      const wallet = window.state.wallets.find(
        (w) => w.id === (expense.walletId || getDefaultWalletId()),
      );

      const walletName = wallet?.name || "Bank";

      list.innerHTML += `<tr class="expense-row">
  <td class="select-col">
    <input
      type="checkbox"
      ${isSelected ? "checked" : ""}
      onchange="toggleTransactionSelection(${Number(expense.id)}, this.checked)"
    />
  </td>

  <td class="date-cell">
    <span class="date-text">${escapeHTML(expense.date)}</span>
    <span class="time-text">${escapeHTML(expense.time || "--:--")}</span>
  </td>

  <td>
    ${escapeHTML(expense.cat)}
    ${
      expense.subcat
        ? `<span class="subcategory-pill">${escapeHTML(expense.subcat)}</span>`
        : ""
    }
  </td>

  <td>
    ${expense.recurring ? "↻ " : ""}
    ${escapeHTML(expense.note)}
  </td>

  <td class="amount-outflow">
    ${formatMoney(expense.amt)}
  </td>

  <!-- WALLET COLUMN -->
  <td class="wallet-cell">
    <span class="wallet-cell-name">
      ${escapeHTML(walletName)}
    </span>
  </td>

  <!-- ACTION COLUMN -->
  <td class="action-cell">
    <div class="transaction-row-actions">
      <button class="edit-btn icon-action-btn" type="button" data-edit-transaction="${escapeHTML(String(expense.id))}" aria-label="Edit transaction" title="Edit transaction"><span aria-hidden="true">✎</span></button>
      <button class="delete-btn icon-action-btn" type="button" onclick="window.localDelete(${Number(expense.id)})" aria-label="Delete transaction" title="Delete transaction"><span aria-hidden="true">🗑</span></button>
    </div>
  </td>
</tr>`;
    });
  }

  if (pagin && pageCount > 1) {
    for (let i = 1; i <= pageCount; i += 1) {
      const btn = document.createElement("button");
      btn.innerText = i;
      btn.className = `page-btn ${i === window.state.currentPage ? "active" : ""}`;
      btn.onclick = () => {
        window.state.currentPage = i;
        refresh();
      };
      pagin.appendChild(btn);
    }
  }

  const balance = window.state.income - totalExp; // used for risk/rating calc against income
  setText(
    "disp-income",
    formatMoney(window.state.income).replace(getCurrencyMeta().symbol, ""),
  );
  setText(
    "disp-expense",
    formatMoney(totalExp).replace(getCurrencyMeta().symbol, ""),
  );
  setText(
    "disp-balance",
    formatMoney(totalWalletBalance).replace(getCurrencyMeta().symbol, ""),
  );

  // spent % of income
  const spentPct =
    window.state.income > 0
      ? Math.round((totalExp / window.state.income) * 100)
      : 0;
  setText("spent-pct", `${spentPct}% of income`);

  updateUINotes();
  setText("fixed-total", formatMoney(fixedAmt));

  const per =
    window.state.goal > 0
      ? Math.min((balance / window.state.goal) * 100, 100)
      : 0;
  const progBar = document.getElementById("prog-bar");
  if (progBar) progBar.style.width = `${Math.max(per, 0)}%`;
  setText("prog-percent", `${Math.round(Math.max(per, 0))}%`);

  window.state.budgetRating = calculateBudgetRating(totalExp, balance);
  setText("budget-rating", `${window.state.budgetRating}/100`);
  const ratingPct = Math.max(0, Math.min(100, Number(window.state.budgetRating) || 0));
  const ratingLabel = document.getElementById("budget-rating-label");
  if (ratingLabel) {
    ratingLabel.textContent = ratingPct >= 80 ? "Excellent money habits" : ratingPct >= 60 ? "Good progress" : ratingPct >= 40 ? "Room to improve" : "Needs attention";
  }
  const ratingFill = document.getElementById("rating-bar-fill");
  if (ratingFill) {
    ratingFill.style.width = `${Math.min(Math.max(ratingPct, 0), 100)}%`;
    ratingFill.style.background =
      ratingPct >= 70
        ? "var(--success)"
        : ratingPct >= 40
          ? "var(--warning)"
          : "var(--danger)";
  }
  updateBulkToolbar();
  renderWallets();
  renderDashboardInsights(totalExp, balance);
  renderQuickTemplates();
  updateHealth(balance);
  renderCategoryCaps();
  renderAdvancedCharts();
  notifyUpcomingRecurringPayments();
  renderSpendingHeatmap();
  detectAnomalies();
}

function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.innerText = value;
}

function renderDashboardInsights(totalSpent, balance) {
  const today = new Date();
  const currentDay = today.getDate();
  const daysInMonth = new Date(
    today.getFullYear(),
    today.getMonth() + 1,
    0,
  ).getDate();
  const remainingDays = Math.max(daysInMonth - currentDay, 1);
  const monthKey = today.toISOString().slice(0, 7);
  const monthExpenses = window.state.expenses.filter((expense) =>
    String(expense.date || "").startsWith(monthKey),
  );
  const monthSpent = monthExpenses.reduce(
    (sum, expense) => sum + expense.amt,
    0,
  );
  const dailyBurn = currentDay > 0 ? monthSpent / currentDay : 0;
  const requiredSavings = Math.max(Number(window.state.goal) || 0, 0);
  const safeDailySpend = Math.max(
    (window.state.income - monthSpent - requiredSavings) / remainingDays,
    0,
  );
  const targetSpend = Math.max(window.state.income - requiredSavings, 0);
  const pace =
    targetSpend > 0 ? Math.min((monthSpent / targetSpend) * 100, 999) : 0;
  const categoryTotals = monthExpenses.reduce((totals, expense) => {
    totals[expense.cat] = (totals[expense.cat] || 0) + expense.amt;
    return totals;
  }, {});
  const topCategory = Object.entries(categoryTotals).sort(
    (a, b) => b[1] - a[1],
  )[0];
  const risk = calculateBudgetRisk(
    monthSpent,
    targetSpend,
    pace,
    safeDailySpend,
  );

  setText("daily-burn", formatMoney(dailyBurn, 0));
  setText("safe-daily-spend", formatMoney(safeDailySpend, 0));
  setText(
    "top-category",
    topCategory
      ? `${topCategory[0]} (${formatMoney(topCategory[1], 0)})`
      : "No data",
  );
  setText("month-pace", `${Math.round(pace)}%`);
  setText("risk-score", `${risk}%`);
  setText(
    "risk-label",
    risk >= 80 ? "High risk" : risk >= 55 ? "Watch" : "Low risk",
  );

  const summary = document.getElementById("smart-summary");
  if (summary) {
    if (!monthExpenses.length) {
      summary.innerText =
        "No spending logged this month yet. Start with a quick transaction or receipt scan.";
    } else if (balance < 0) {
      summary.innerText = `You are over income by ${formatMoney(Math.abs(balance), 0)} in the selected range. Pause flexible spends first.`;
    } else if (pace >= 100 && targetSpend > 0) {
      summary.innerText = `This month has used ${Math.round(pace)}% of your spendable budget. Keep daily spend under ${formatMoney(safeDailySpend, 0)}.`;
    } else {
      summary.innerText = `Current daily burn is ${formatMoney(dailyBurn, 0)}. ${topCategory ? `${topCategory[0]} is leading spend this month.` : "No dominant category yet."}`;
    }
  }

  const meter = document.querySelector(".risk-meter");
  if (meter) {
    meter.style.setProperty("--risk", `${risk}%`);
    meter.dataset.level = risk >= 80 ? "high" : risk >= 55 ? "medium" : "low";
  }
}

function calculateBudgetRisk(monthSpent, targetSpend, pace, safeDailySpend) {
  if (window.state.income <= 0) return 0;
  const overspendPressure =
    targetSpend > 0 ? pace : (monthSpent / window.state.income) * 100;
  const dailyPressure = safeDailySpend <= 0 && monthSpent > 0 ? 35 : 0;
  const capPressure = Object.entries(window.state.categoryCaps || {}).reduce(
    (maxPressure, [cat, limit]) => {
      const spent = window.state.expenses
        .filter(
          (expense) =>
            expense.cat === cat &&
            String(expense.date || "").slice(0, 7) ===
              new Date().toISOString().slice(0, 7),
        )
        .reduce((sum, expense) => sum + expense.amt, 0);
      return Math.max(
        maxPressure,
        limit > 0 ? Math.min((spent / limit) * 100, 100) : 0,
      );
    },
    0,
  );
  return Math.max(
    0,
    Math.min(
      100,
      Math.round(overspendPressure * 0.65 + capPressure * 0.25 + dailyPressure),
    ),
  );
}

function renderQuickTemplates() {
  const holder = document.getElementById("quick-template-bar");
  if (!holder) return;

  const templates = getQuickTemplates();
  if (!templates.length) {
    holder.innerHTML =
      '<p class="empty-note">Quick suggestions appear after you log a few transactions.</p>';
    return;
  }

  holder.innerHTML = templates
    .map(
      (item, index) => `
        <button type="button" class="quick-template" data-template-index="${index}">
          <span>${escapeHTML(item.cat)}</span>
          <b>${formatMoney(item.amt, 0)}</b>
          <small>${escapeHTML(item.note)}</small>
        </button>`,
    )
    .join("");

  holder.querySelectorAll("[data-template-index]").forEach((button) => {
    button.addEventListener("click", () =>
      applyQuickTemplate(templates[Number(button.dataset.templateIndex)]),
    );
  });
}

function getQuickTemplates() {
  const grouped = {};
  window.state.expenses.forEach((expense) => {
    const key = `${expense.cat}::${String(expense.note || "").toLowerCase()}`;
    grouped[key] = grouped[key] || {
      cat: expense.cat,
      note: expense.note,
      amounts: [],
      lastId: 0,
    };
    grouped[key].amounts.push(expense.amt);
    grouped[key].lastId = Math.max(
      grouped[key].lastId,
      Number(expense.id) || 0,
    );
  });

  return Object.values(grouped)
    .map((entry) => ({
      cat: entry.cat,
      note: entry.note || entry.cat,
      amt:
        entry.amounts.reduce((sum, value) => sum + value, 0) /
        entry.amounts.length,
      score: entry.amounts.length * 2 + entry.lastId / 1000000000000,
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 4);
}

function applyQuickTemplate(template) {
  if (!template) return;
  const amountInput = document.getElementById("amt");
  const categoryInput = document.getElementById("cat");
  const noteInput = document.getElementById("note");
  const dateInput = document.getElementById("date");
  if (amountInput) amountInput.value = Math.max(template.amt, 0).toFixed(2);
  if (categoryInput) {
    const hasOption = Array.from(categoryInput.options).some(
      (option) => option.value === template.cat,
    );
    categoryInput.value = hasOption ? template.cat : "Other";
    handleCategoryChange(categoryInput.value);
    if (!hasOption) {
      const customInput = document.getElementById("custom-cat");
      if (customInput) customInput.value = template.cat;
    }
  }
  if (noteInput) noteInput.value = template.note;
  if (dateInput && !dateInput.value)
    dateInput.value = new Date().toISOString().slice(0, 10);
}

function updateHealth(balance) {
  const healthTag = document.getElementById("health-tag");
  const healthMsg = document.getElementById("ai-health-msg");
  if (!healthTag || !healthMsg) return;

  if (balance < 0) {
    healthTag.innerText = "CRITICAL";
    healthTag.style.background = "var(--danger)";
    healthMsg.innerText = "Spending exceeds income.";
    return;
  }

  if (window.state.goal > 0 && balance < window.state.goal) {
    healthTag.innerText = "WATCH";
    healthTag.style.background = "var(--warning)";
    healthMsg.innerText = "You are below the saving target for this range.";
    return;
  }

  healthTag.innerText = "HEALTHY";
  healthTag.style.background = "var(--success)";
  healthMsg.innerText = "Your finances are stable.";
}

function calculateBudgetRating(totalSpent = null, balance = null) {
  const expenses = Array.isArray(window.state.expenses) ? window.state.expenses : [];
  const spent = totalSpent ?? expenses.reduce((sum, expense) => sum + (Number(expense.amt) || 0), 0);
  const income = Math.max(0, Number(window.state.income) || 0);
  const currentBalance = balance ?? (income - spent);

  // A new user starts at a neutral score; scores are always on a 0–100 scale.
  if (income <= 0 && spent <= 0) return 50;

  let score = 50;
  if (income > 0) {
    const savingsRate = (income - spent) / income;
    score += Math.max(-30, Math.min(30, Math.round(savingsRate * 40)));
  } else if (spent > 0) {
    score -= 20;
  }

  const caps = window.state.categoryCaps || {};
  let exceededCaps = 0;
  for (const [category, rawLimit] of Object.entries(caps)) {
    const limit = Number(rawLimit);
    if (!Number.isFinite(limit) || limit <= 0) continue;
    const categorySpent = expenses
      .filter((expense) => expense.cat === category)
      .reduce((sum, expense) => sum + (Number(expense.amt) || 0), 0);
    if (categorySpent > limit) {
      exceededCaps += Math.min(12, Math.ceil(((categorySpent - limit) / limit) * 12));
    }
  }
  score -= Math.min(30, exceededCaps);

  if (window.state.goal > 0) {
    const goalProgress = Math.max(0, Math.min(1, currentBalance / Number(window.state.goal)));
    score += Math.round(goalProgress * 10);
  }
  return Math.max(0, Math.min(100, Math.round(score)));
}

function renderAdvancedCharts() {
  if (window.state.activeView !== "dashboard") {
    calculateForecast();
    return;
  }

  if (!window.Chart) {
    setText("ai-prediction", "Charts unavailable while offline.");
    return;
  }

  const trendCtx = document.getElementById("trendChart")?.getContext("2d");
  const budgetCtx = document.getElementById("budgetBarChart")?.getContext("2d");
  const donutCtx = document
    .getElementById("categoryDoughnutChart")
    ?.getContext("2d");
  if (!trendCtx || !budgetCtx || !donutCtx) return;

  window.state.trendChartInstance?.destroy();
  window.state.budgetChartInstance?.destroy();
  window.state.categoryChartInstance?.destroy();

  const { currency, rate } = getCurrencyMeta();
  const totalSpent = window.state.filteredData.reduce(
    (sum, expense) => sum + expense.amt,
    0,
  );
  const forecastAmt = calculateForecast();
  const dailyData = {};
  [...window.state.filteredData].reverse().forEach((expense) => {
    dailyData[expense.date] =
      (dailyData[expense.date] || 0) + expense.amt * rate;
  });

  window.state.trendChartInstance = new Chart(trendCtx, {
    type: "line",
    data: {
      labels: Object.keys(dailyData).slice(-10),
      datasets: [
        {
          label: `Spending (${currency})`,
          data: Object.values(dailyData).slice(-10),
          borderColor: "#6366f1",
          backgroundColor: "rgba(99, 102, 241, 0.12)",
          tension: 0.3,
          fill: true,
        },
      ],
    },
    options: chartOptions(),
  });

  window.state.budgetChartInstance = new Chart(budgetCtx, {
    type: "bar",
    data: {
      labels: ["Savings Goal", "Actual Spent", "Forecasted Spend"],
      datasets: [
        {
          label: currency,
          data: [
            window.state.goal * rate,
            totalSpent * rate,
            forecastAmt * rate,
          ],
          backgroundColor: ["#f59e0b", "#22c55e", "#6366f1"],
        },
      ],
    },
    options: chartOptions(false),
  });

  const catTotals = {};
  window.state.filteredData.forEach((expense) => {
    catTotals[expense.cat] = (catTotals[expense.cat] || 0) + expense.amt * rate;
  });

  window.state.categoryChartInstance = new Chart(donutCtx, {
    type: "doughnut",
    data: {
      labels: Object.keys(catTotals).length
        ? Object.keys(catTotals)
        : ["No data"],
      datasets: [
        {
          data: Object.values(catTotals).length
            ? Object.values(catTotals)
            : [1],
          backgroundColor: [
            "#6366f1",
            "#22c55e",
            "#f59e0b",
            "#ef4444",
            "#ec4899",
            "#8b5cf6",
          ],
        },
      ],
    },
    options: chartOptions(),
  });
}

function chartOptions(showLegend = true) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    plugins: { legend: { display: showLegend } },
  };
}

function calculateForecast() {
  const predictionEl = document.getElementById("ai-prediction");
  const today = new Date();
  const daysInMonth = new Date(
    today.getFullYear(),
    today.getMonth() + 1,
    0,
  ).getDate();
  const currentDay = today.getDate();
  const currentMonthExpenses = window.state.expenses.filter((expense) => {
    const date = new Date(`${expense.date}T00:00:00`);
    return (
      date.getMonth() === today.getMonth() &&
      date.getFullYear() === today.getFullYear()
    );
  });

  const total = currentMonthExpenses.reduce(
    (sum, expense) => sum + expense.amt,
    0,
  );
  const monthTotals = getRecentMonthTotals(6);
  const historicalAverage = monthTotals.length
    ? monthTotals.reduce((sum, value, index) => sum + value * (index + 1), 0) /
      monthTotals.reduce((sum, _value, index) => sum + index + 1, 0)
    : 0;
  const runRate = currentDay > 0 ? (total / currentDay) * daysInMonth : 0;
  const categorySeasonality = calculateCategorySeasonality();
  const tensorForecast = calculateTensorForecast([
    runRate,
    historicalAverage,
    categorySeasonality,
  ]);
  const forecast = Math.max(
    0,
    tensorForecast ??
      runRate * 0.55 + historicalAverage * 0.35 + categorySeasonality * 0.1,
  );

  if (predictionEl) {
    predictionEl.style.fontSize =
      currentMonthExpenses.length < 3 ? "0.85rem" : "1.1rem";
    predictionEl.innerText =
      currentMonthExpenses.length < 3
        ? `${formatMoney(forecast)} (estimate · limited data)`
        : `${formatMoney(forecast)} estimated spending`;
  }

  return forecast;
}

function calculateTensorForecast(features) {
  if (!window.tf) return null;
  try {
    return tf.tidy(() => {
      const featureTensor = tf.tensor1d(features);
      const weights = tf.tensor1d([0.55, 0.35, 0.1]);
      return featureTensor.mul(weights).sum().arraySync();
    });
  } catch (error) {
    console.warn("TensorFlow forecast fallback used:", error);
    return null;
  }
}

function getRecentMonthTotals(limit) {
  const totals = {};
  window.state.expenses.forEach((expense) => {
    const key = String(expense.date || "").slice(0, 7);
    if (!key) return;
    totals[key] = (totals[key] || 0) + expense.amt;
  });
  return Object.entries(totals)
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(-limit)
    .map(([, value]) => value);
}

function calculateCategorySeasonality() {
  const byCategory = {};
  window.state.expenses.forEach((expense) => {
    byCategory[expense.cat] = byCategory[expense.cat] || [];
    byCategory[expense.cat].push(expense.amt);
  });
  return Object.values(byCategory).reduce((sum, values) => {
    const recent = values.slice(-3);
    if (!recent.length) return sum;
    return (
      sum + recent.reduce((total, value) => total + value, 0) / recent.length
    );
  }, 0);
}

document.getElementById("exp-form")?.addEventListener("submit", (event) => {
  event.preventDefault();

  if (!(Number(window.state.income) > 0)) {
    alert("Before recording your first transaction, please set your monthly income in Financial Goals. This helps Finora calculate your balance and spending percentage correctly.");
    setActiveView("limits");
    document.getElementById("inc-val")?.focus();
    document.getElementById("inc-val")?.scrollIntoView({ behavior: "smooth", block: "center" });
    return;
  }

  const defaultWalletIds = new Set(["wallet-bank", "wallet-cash", "wallet-digital"]);
  const hasConfiguredWallet = window.state.wallets.some((wallet) => !defaultWalletIds.has(wallet.id));
  if (!hasConfiguredWallet && localStorage.getItem("finoraWalletSetupComplete") !== "true") {
    alert("Before adding your first transaction, please set up at least one wallet (for example Bank, Cash, or UPI). Category-wise limits are optional and can be added later.");
    setActiveView("transactions");
    const walletPanel = document.getElementById("wallet-manager-panel");
    if (walletPanel) walletPanel.classList.remove("wallet-form-collapsed");
    const walletToggle = document.getElementById("toggle-wallet-panel");
    if (walletToggle) { walletToggle.textContent = "Hide Wallet Form"; walletToggle.setAttribute("aria-expanded", "true"); }
    document.getElementById("wallet-name")?.focus();
    document.getElementById("wallet-manager-panel")?.scrollIntoView({ behavior: "smooth", block: "center" });
    return;
  }

  const amount = parseFloat(document.getElementById("amt")?.value);
  if (!Number.isFinite(amount) || amount <= 0) {
    alert("Enter a valid amount greater than zero.");
    return;
  }

  const selectedDate = document.getElementById("date")?.value;
  if (!selectedDate) {
    alert("Select a transaction date.");
    return;
  }

  let finalCategory = document.getElementById("cat")?.value || "Other";
  const customCatValue = cleanTextInput(
    document.getElementById("custom-cat")?.value,
  );
  if (finalCategory === "Other" && customCatValue)
    finalCategory = customCatValue;

  // ── Budget Lock Mode: block entry if this category's limit is hit ──
  if (window.state.budgetLock) {
    const limit = window.state.categoryCaps?.[finalCategory];
    if (limit > 0) {
      const monthKey = selectedDate.slice(0, 7);
      const spentThisMonth = window.state.expenses
        .filter(
          (e) =>
            e.cat === finalCategory &&
            String(e.date || "").startsWith(monthKey),
        )
        .reduce((sum, e) => sum + e.amt, 0);
      if (spentThisMonth >= limit) {
        alert(
          `🔒 "${finalCategory}" is locked — you've hit its limit of ${formatMoney(limit)}.\n\nGo to the Limits tab and click "Unfreeze — raise limit" to add more, or wait for next month.`,
        );
        return;
      }
    }
  }

  // subcat: only meaningful when Other is selected; never default to "General"
  const subcatRaw = cleanTextInput(
    document.getElementById("subcat")?.value,
    "",
  );

  const now = new Date();
  window.state.expenses.push({
    id: Date.now(),
    amt: amount,
    cat: cleanTextInput(finalCategory, "Other"),
    subcat: subcatRaw,
    note: cleanTextInput(document.getElementById("note")?.value, "Expense"),
    date: selectedDate,
    walletId:
      document.getElementById("wallet")?.value ||
      getSelectedWalletId("transaction"),
    time: now.toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      hour12: true,
    }),
    recurring: Boolean(document.getElementById("is-recurring")?.checked),
  });

  saveToLocal();
  refresh();
  const cap = Number(window.state.categoryCaps?.[finalCategory] || 0);
  if (cap > 0) {
    const monthKey = selectedDate.slice(0, 7);
    const categorySpent = window.state.expenses.filter((expense) => expense.cat === finalCategory && String(expense.date || "").startsWith(monthKey)).reduce((sum, expense) => sum + Number(expense.amt || 0), 0);
    const pct = categorySpent / cap * 100;
    if (pct >= 100) alert(`Budget alert: ${finalCategory} has reached ${Math.round(pct)}% of its limit (${formatMoney(categorySpent)} / ${formatMoney(cap)}).`);
    else if (pct >= 80) alert(`Budget reminder: ${finalCategory} has used ${Math.round(pct)}% of its limit. Remaining: ${formatMoney(Math.max(0, cap - categorySpent))}.`);
  }
  if (window.state.expenses.length >= 10 && !Object.values(window.state.categoryCaps || {}).some((limit) => Number(limit) > 0) && localStorage.getItem("finoraLimitsSuggestionDismissed") !== "true") {
    window.setTimeout(() => {
      if (confirm("You have recorded 10 transactions. Would you like to set optional category-wise spending limits to help manage your budget?")) {
        setActiveView("limits");
        document.getElementById("cap-cat")?.focus();
      } else {
        localStorage.setItem("finoraLimitsSuggestionDismissed", "true");
      }
    }, 250);
  }
  event.target.reset();
  document.getElementById("date").value = new Date()
    .toISOString()
    .split("T")[0];
  handleCategoryChange("Food");
  renderWallets();
});

function applyTransactionFilters() {
  window.state.currentPage = 1;
  refresh();
}

window.applyTransactionFilters = applyTransactionFilters;

function clearFilters() {
  resetDateFilters();

  const searchInput = document.getElementById("search-input");
  if (searchInput) {
    searchInput.value = "";
  }

  window.state.currentPage = 1;
  refresh();
}

window.clearFilters = clearFilters;

window.exportToExcel = () => {
  if (!window.XLSX) {
    alert(
      "Excel export library is unavailable. Check your connection and reload.",
    );
    return;
  }

  const rows = getExportRows();
  const worksheet = XLSX.utils.json_to_sheet(rows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "Expenses");
  XLSX.writeFile(
    workbook,
    `smart-budget-tracker-${new Date().toISOString().slice(0, 10)}.xlsx`,
  );
};

async function restoreFinoraBackup(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    const parsed = JSON.parse(await file.text());
    const payload = parsed.data && typeof parsed.data === "object" ? parsed.data : parsed;
    if (!payload || !Array.isArray(payload.expenses) || !Array.isArray(payload.wallets)) throw new Error("This file does not look like a Finora JSON backup.");
    if (!confirm("Restore this backup? Your current local Finora data will be replaced.")) { event.target.value = ""; return; }
    applyDataPayload(payload);
    await persistData({ skipCloud: true });
    saveToLocal();
    renderWallets(); refresh(); updateCurrencyUI(); updateUINotes();
    alert("Backup restored. If you are signed in, wait for the cloud sync status to update.");
  } catch (error) {
    console.error("Backup restore failed:", error);
    alert(`Could not restore backup: ${error.message || "Invalid JSON file."}`);
  } finally { event.target.value = ""; }
}

window.restoreFinoraBackup = restoreFinoraBackup;

window.exportDataJSON = () => {
  const payload = { ...getDataPayload(), exportedAt: new Date().toISOString() };

  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: "application/json",
  });
  downloadBlob(
    blob,
    `smart-budget-backup-${new Date().toISOString().slice(0, 10)}.json`,
  );
};


window.exportDetailedPDF = async () => {
  if (!window.jspdf?.jsPDF) {
    alert(
      "PDF export library is unavailable. Check your internet connection and reload.",
    );
    return;
  }

  try {
    const { jsPDF } = window.jspdf;

    const doc = new jsPDF("p", "pt", "a4");

    // ── Page dimensions ────────────────────────────────────────────
    const PAGE_W = doc.internal.pageSize.getWidth();
    const PAGE_H = doc.internal.pageSize.getHeight();

    // ── Page layout constants ──────────────────────────────────────
    const MARGIN_X = 40;
    const TOP_MARGIN = 40;
    const BOTTOM_MARGIN = 50;

    // ── Currency ───────────────────────────────────────────────────
    const { currency, symbol } = getCurrencyMeta();

    const pdfMoney = (value) => {
      const amount = Number(value || 0);

      if (currency === "INR" || symbol === "₹") {
        return `Rs. ${amount.toLocaleString("en-IN", {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        })}`;
      }

      return formatMoney(amount);
    };

    // ── Colors ─────────────────────────────────────────────────────
    const PRIMARY = [99, 102, 241];
    const DARK = [15, 23, 42];
    const MID = [71, 85, 105];
    const LIGHT_BG = [241, 245, 249];
    const WHITE = [255, 255, 255];
    const SUCCESS = [16, 185, 129];
    const DANGER = [239, 68, 68];
    const GOLD = [245, 158, 11];

    // ── Page position ──────────────────────────────────────────────
    let y = 92;

    /**
     * Check whether enough space remains on the current page.
     * If not, create a new page and reset y to the top margin.
     */
    const ensurePageSpace = (requiredHeight = 80) => {
      if (y + requiredHeight > PAGE_H - BOTTOM_MARGIN) {
        doc.addPage();
        y = TOP_MARGIN;
        return true;
      }

      return false;
    };

    /**
     * Draw a clean section heading.
     * If there isn't enough room, the heading starts on a new page.
     */
    const drawSectionTitle = (title, lineWidth = 130, requiredHeight = 120) => {
      ensurePageSpace(requiredHeight);

      doc.setFont("helvetica", "bold");
      doc.setFontSize(12);
      doc.setTextColor(...DARK);

      doc.text(title, MARGIN_X, y);

      doc.setDrawColor(...PRIMARY);
      doc.setLineWidth(2);
      doc.line(MARGIN_X, y + 4, MARGIN_X + lineWidth, y + 4);

      y += 18;
    };

    // ── Header banner ──────────────────────────────────────────────
    doc.setFillColor(...PRIMARY);
    doc.roundedRect(0, 0, PAGE_W, 72, 0, 0, "F");

    doc.setTextColor(...WHITE);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(18);
    doc.text("SMART BUDGET TRACKER", MARGIN_X, 32);

    doc.setFont("helvetica", "normal");
    doc.setFontSize(10);

    doc.text("Financial Report", MARGIN_X, 50);

    const generatedDate = new Date();

    doc.text(
      `Generated: ${generatedDate.toLocaleDateString()} at ${generatedDate.toLocaleTimeString()}`,
      PAGE_W - MARGIN_X,
      50,
      {
        align: "right",
      },
    );

    const periodFrom = localStorage.getItem("financeFrom");
    const periodTo = localStorage.getItem("financeTo");

    if (periodFrom && periodTo) {
      doc.setFontSize(9);

      doc.text(`Period: ${periodFrom}  →  ${periodTo}`, PAGE_W - MARGIN_X, 64, {
        align: "right",
      });
    }

    // ── Summary data ───────────────────────────────────────────────
    const expensesToProcess = window.state.filteredData || [];

    const totalExp = expensesToProcess.reduce(
      (s, e) => s + Number(e.amt || 0),
      0,
    );

    const netBal = Number(window.state.income || 0) - totalExp;

    const savePct =
      Number(window.state.income || 0) > 0
        ? Math.min(
            100,
            Math.round((netBal / Number(window.state.income)) * 100),
          )
        : 0;

    // ── Summary cards ──────────────────────────────────────────────
    const cards = [
      {
        label: "Total Income",
        value: pdfMoney(window.state.income),
        color: SUCCESS,
      },
      {
        label: "Total Spent",
        value: pdfMoney(totalExp),
        color: DANGER,
      },
      {
        label: "Net Balance",
        value: pdfMoney(netBal),
        color: netBal >= 0 ? SUCCESS : DANGER,
      },
      {
        label: "Savings Rate",
        value: `${savePct}%`,
        color: savePct >= 20 ? SUCCESS : GOLD,
      },
    ];

    const cardW = (PAGE_W - 80 - 3 * 10) / 4;

    cards.forEach((card, i) => {
      const x = MARGIN_X + i * (cardW + 10);

      doc.setFillColor(...LIGHT_BG);

      doc.roundedRect(x, y, cardW, 52, 6, 6, "F");

      doc.setDrawColor(...card.color);
      doc.setLineWidth(3);

      doc.line(x, y + 48, x + cardW, y + 48);

      doc.setTextColor(...MID);
      doc.setFont("helvetica", "normal");
      doc.setFontSize(8);

      doc.text(card.label.toUpperCase(), x + cardW / 2, y + 14, {
        align: "center",
      });

      doc.setTextColor(...card.color);
      doc.setFont("helvetica", "bold");
      doc.setFontSize(13);

      doc.text(card.value, x + cardW / 2, y + 34, {
        align: "center",
      });
    });

    y += 68;

    // ==============================================================
    // WALLET BALANCES
    // ==============================================================

    drawSectionTitle("Wallet Balances", 120, 100);

    const walletRows = window.state.wallets.map((w) => {
      const avail =
        Number(w.balance || 0) -
        window.state.expenses
          .filter((e) => (e.walletId || "wallet-bank") === w.id)
          .reduce((s, e) => s + Number(e.amt || 0), 0);

      return [w.name, pdfMoney(w.balance), pdfMoney(avail)];
    });

    doc.autoTable({
      startY: y,

      head: [["Wallet", "Opening Balance", "Available Balance"]],

      body: walletRows,

      theme: "grid",

      pageBreak: "auto",

      showHead: "everyPage",

      headStyles: {
        fillColor: PRIMARY,
        textColor: WHITE,
        fontStyle: "bold",
        fontSize: 9,
        cellPadding: 6,
      },

      bodyStyles: {
        fontSize: 9,
        textColor: DARK,
        cellPadding: 6,
        valign: "middle",
      },

      alternateRowStyles: {
        fillColor: LIGHT_BG,
      },

      columnStyles: {
        1: {
          halign: "right",
        },

        2: {
          halign: "right",
          fontStyle: "bold",
        },
      },

      margin: {
        left: MARGIN_X,
        right: MARGIN_X,
        bottom: BOTTOM_MARGIN,
      },

      tableWidth: PAGE_W - 80,
    });

    y = doc.lastAutoTable.finalY + 24;

    // ==============================================================
    // SPENDING BY CATEGORY
    // ==============================================================

    drawSectionTitle("Spending by Category", 155, 100);

    ensurePageSpace(100);

    const catMap = {};

    expensesToProcess.forEach((e) => {
      const category = e.cat || "Uncategorized";

      catMap[category] = (catMap[category] || 0) + Number(e.amt || 0);
    });

    const catRows = Object.entries(catMap)
      .sort((a, b) => b[1] - a[1])
      .map(([cat, total]) => {
        const pct =
          totalExp > 0 ? ((total / totalExp) * 100).toFixed(1) + "%" : "0%";

        return [cat, pdfMoney(total), pct];
      });

    doc.autoTable({
      startY: y,

      head: [["Category", "Amount Spent", "% of Total"]],

      body: catRows.length ? catRows : [["No data", "—", "—"]],

      foot: [["GRAND TOTAL", pdfMoney(totalExp), "100%"]],

      theme: "striped",

      pageBreak: "auto",

      showHead: "everyPage",

      showFoot: "lastPage",

      headStyles: {
        fillColor: PRIMARY,
        textColor: WHITE,
        fontStyle: "bold",
        fontSize: 9,
        cellPadding: 6,
      },

      footStyles: {
        fillColor: DARK,
        textColor: WHITE,
        fontStyle: "bold",
        fontSize: 9,
        cellPadding: 6,
      },

      bodyStyles: {
        fontSize: 9,
        textColor: DARK,
        cellPadding: 6,
        valign: "middle",
      },

      alternateRowStyles: {
        fillColor: LIGHT_BG,
      },

      columnStyles: {
        1: {
          halign: "right",
        },

        2: {
          halign: "right",
        },
      },

      margin: {
        left: MARGIN_X,
        right: MARGIN_X,
        bottom: BOTTOM_MARGIN,
      },

      tableWidth: PAGE_W - 80,
    });

    y = doc.lastAutoTable.finalY + 24;

    // ==============================================================
    // TRANSACTION LEDGER
    // ==============================================================

    drawSectionTitle("Transaction Ledger", 135, 125);

    const txRows = expensesToProcess.map((e) => {
      const w = window.state.wallets.find((wallet) => wallet.id === e.walletId);

      return [
        e.date,

        e.cat + (e.subcat ? ` › ${e.subcat}` : ""),

        e.note || "—",

        w ? w.name : "Bank",

        e.recurring ? "✓" : "",

        pdfMoney(e.amt),
      ];
    });

    doc.autoTable({
      startY: y,

      head: [["Date", "Category", "Note", "Wallet", "Recur", "Amount"]],

      body: txRows.length
        ? txRows
        : [["—", "No transactions found", "—", "—", "—", "—"]],

      foot: [["", "", "", "", "TOTAL", pdfMoney(totalExp)]],

      theme: "striped",

      /*
       * Let autoTable automatically split the
       * transaction table across pages.
       */
      pageBreak: "auto",

      rowPageBreak: "auto",

      /*
       * Repeat the transaction header on every page.
       */
      showHead: "everyPage",

      /*
       * Show TOTAL only on the final transaction page.
       */
      showFoot: "lastPage",

      headStyles: {
        fillColor: PRIMARY,
        textColor: WHITE,
        fontStyle: "bold",
        fontSize: 8,
        cellPadding: 6,
      },

      footStyles: {
        fillColor: DARK,
        textColor: WHITE,
        fontStyle: "bold",
        fontSize: 9,
        cellPadding: 6,
      },

      bodyStyles: {
        fontSize: 8,
        textColor: DARK,
        cellPadding: 6,
        valign: "middle",
      },

      alternateRowStyles: {
        fillColor: LIGHT_BG,
      },

      columnStyles: {
        0: {
          cellWidth: 62,
        },

        1: {
          cellWidth: 100,
        },

        2: {
          cellWidth: 145,
        },

        3: {
          cellWidth: 75,
        },

        4: {
          cellWidth: 55,
          halign: "center",
        },

        5: {
          cellWidth: 78,
          halign: "right",
          fontStyle: "bold",
        },
      },

      margin: {
        left: MARGIN_X,
        right: MARGIN_X,
        bottom: BOTTOM_MARGIN,
      },

      tableWidth: PAGE_W - 80,

      /*
       * Keep TOTAL visually bold.
       */
      didParseCell: function (data) {
        if (data.section === "foot") {
          data.cell.styles.fontStyle = "bold";
        }
      },
    });

    // ==============================================================
    // FOOTER ON EVERY PAGE
    // ==============================================================

    const totalPages = doc.internal.getNumberOfPages();

    for (let i = 1; i <= totalPages; i++) {
      doc.setPage(i);

      /*
       * Footer background
       */
      doc.setFillColor(...LIGHT_BG);

      doc.rect(0, PAGE_H - 24, PAGE_W, 24, "F");

      /*
       * Footer text
       */
      doc.setTextColor(...MID);
      doc.setFont("helvetica", "normal");
      doc.setFontSize(8);

      doc.text("Smart Budget Tracker — Abdul Rahman Ali", MARGIN_X, PAGE_H - 9);

      doc.text(`Page ${i} of ${totalPages}`, PAGE_W - MARGIN_X, PAGE_H - 9, {
        align: "right",
      });
    }

    // ==============================================================
    // SAVE PDF
    // ==============================================================

    doc.save(`Budget-Report-${new Date().toISOString().slice(0, 10)}.pdf`);
  } catch (err) {
    console.error("PDF generation failed:", err);

    alert("An error occurred generating the PDF. Check console for details.");
  }
};

function getExportRows() {
  const source = window.state.filteredData.length
    ? window.state.filteredData
    : window.state.expenses;
  return source.map((expense) => ({
    Date: expense.date,
    Time: expense.time || "",
    Category: expense.cat,
    Note: expense.note,
    Amount: expense.amt,
    Wallet:
      window.state.wallets.find((wallet) => wallet.id === expense.walletId)
        ?.name || "Bank",
    Recurring: expense.recurring ? "Yes" : "No",
  }));
}

function downloadBlob(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

async function fetchExchangeRates() {
  try {
    const response = await fetch("https://open.er-api.com/v6/latest/INR");
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    if (data?.rates) {
      window.state.exchangeRates = { ...fallbackRates, ...data.rates };
      refresh();
    }
  } catch (error) {
    console.warn("Using fallback exchange rates:", error);
  }
}

const SpeechRecognition =
  window.SpeechRecognition || window.webkitSpeechRecognition;
let activeRecognition = null;
let isListening = false;

function setVoiceStatus(message, color = "var(--warning)") {
  ["voice-status", "transaction-voice-status"].forEach((id) => {
    const statusText = document.getElementById(id);
    if (statusText) statusText.innerText = message;
  });
  ["voice-btn", "transaction-voice-btn"].forEach((id) => {
    const voiceBtn = document.getElementById(id);
    if (voiceBtn) voiceBtn.style.background = color;
  });
}

function manualVoiceFallback() {
  const command = prompt(
    "Voice recognition is not available here. Type a command, for example: 100 on Petrol",
  );
  if (command?.trim()) parseVoiceCommand(command.toLowerCase());
}

window.startVoiceInput = () => {
  if (!SpeechRecognition) {
    setVoiceStatus(
      "Speech recognition is not supported here. Type the command instead.",
    );
    manualVoiceFallback();
    return;
  }

  if (
    location.protocol !== "https:" &&
    !["localhost", "127.0.0.1"].includes(location.hostname)
  ) {
    setVoiceStatus(
      "Mobile voice needs HTTPS or localhost. Type the command for now.",
    );
    manualVoiceFallback();
    return;
  }

  if (isListening && activeRecognition) {
    activeRecognition.stop();
    return;
  }

  activeRecognition = new SpeechRecognition();
  activeRecognition.lang = "en-IN";
  activeRecognition.interimResults = false;
  activeRecognition.continuous = false;
  activeRecognition.maxAlternatives = 1;

  activeRecognition.onstart = () => {
    isListening = true;
    setVoiceStatus("Listening... say '100 on Petrol'", "var(--danger)");
  };

  activeRecognition.onresult = (event) => {
    const transcript = event.results?.[0]?.[0]?.transcript?.toLowerCase() || "";
    if (!transcript) {
      setVoiceStatus("No speech detected. Try again.");
      return;
    }
    setVoiceStatus(`Heard: ${transcript}`, "var(--warning)");
    parseVoiceCommand(transcript);
  };

  activeRecognition.onerror = (event) => {
    const messages = {
      "not-allowed":
        "Microphone permission was blocked. Allow mic access in browser settings.",
      "service-not-allowed":
        "Speech service is blocked on this browser/device.",
      "no-speech": "No speech detected. Try again closer to the mic.",
      network:
        "Speech recognition needs an internet connection on this browser.",
    };
    setVoiceStatus(
      messages[event.error] ||
        "Voice input failed. Type the command or try again.",
    );
    if (event.error === "service-not-allowed" || event.error === "network")
      manualVoiceFallback();
  };

  activeRecognition.onend = () => {
    isListening = false;
    activeRecognition = null;
    ["voice-btn", "transaction-voice-btn"].forEach((id) => {
      const voiceBtn = document.getElementById(id);
      if (voiceBtn) voiceBtn.style.background = "var(--warning)";
    });
  };

  try {
    activeRecognition.start();
  } catch {
    setVoiceStatus("Voice input is already starting. Try again in a moment.");
  }
};

function parseVoiceCommand(text) {
  const statusTargets = ["voice-status", "transaction-voice-status"]
    .map((id) => document.getElementById(id))
    .filter(Boolean);
  const amountMatch = text.match(/\d+(\.\d+)?/);
  const amount = amountMatch ? amountMatch[0] : null;
  if (!amount) {
    statusTargets.forEach((status) => {
      status.innerText = "Couldn't detect amount. Try: '100 on Petrol'";
    });
    return;
  }

  let note = text.replace(amount, "").trim();
  [" on ", " for ", " pe ", " ka "].some((connector) => {
    if (!text.includes(connector)) return false;
    note = text.split(connector).pop().replace(amount, "").trim();
    return true;
  });
  note = cleanTextInput(note, "Voice Entry");

  let matchedCategory = "Other";
  for (const [cat, keywords] of Object.entries(categoryMap)) {
    const hasMatch = keywords.some((keyword) =>
      new RegExp(`\\b${escapeRegExp(keyword)}\\b`, "i").test(text),
    );
    if (hasMatch) {
      matchedCategory = cat;
      break;
    }
  }

  document.getElementById("amt").value = amount;
  document.getElementById("note").value = titleCase(note);
  const catField = document.getElementById("cat");
  catField.value = matchedCategory;
  handleCategoryChange(matchedCategory);
  if (matchedCategory === "Other")
    document.getElementById("custom-cat").value = titleCase(note);
  statusTargets.forEach((status) => {
    status.innerText = `Matched: ${formatMoney(parseFloat(amount))} for ${note} (${matchedCategory}). Review and save.`;
  });
}

window.scanReceipt = async (event) => {
  const file = event.target.files?.[0];
  const status = document.getElementById("ocr-status");
  if (!file) return;
  if (!window.Tesseract) {
    alert(
      "Receipt OCR library is unavailable. Check your connection and reload.",
    );
    event.target.value = "";
    return;
  }

  try {
    if (status) status.innerText = "Scanning receipt image...";
    const result = await Tesseract.recognize(file, "eng");
    const text = result.data?.text || "";
    const parsed = parseReceiptText(text);
    if (parsed.amount) document.getElementById("amt").value = parsed.amount;
    if (parsed.date) document.getElementById("date").value = parsed.date;
    document.getElementById("note").value = parsed.note || "Receipt";
    const catField = document.getElementById("cat");
    catField.value = parsed.category;
    handleCategoryChange(parsed.category);
    if (status) {
      status.innerText = parsed.amount
        ? `Receipt parsed: ${formatMoney(parsed.amount)}${parsed.date ? ` on ${parsed.date}` : ""}. Review before saving.`
        : "Receipt scanned, but no total was detected. Enter the amount manually.";
    }
  } catch (error) {
    console.error("Receipt OCR failed:", error);
    if (status) status.innerText = "Receipt scan failed. Try a clearer photo.";
  } finally {
    event.target.value = "";
  }
};

function parseReceiptText(text) {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const totalLines = lines.filter((line) =>
    /total|amount due|grand total|net amount|balance/i.test(line),
  );
  const amountCandidates = (totalLines.length ? totalLines : lines)
    .flatMap((line) =>
      [
        ...line.matchAll(
          /(?:rs\.?|inr|\u20b9|\$)?\s*(\d{1,6}(?:[,.]\d{2})?)/gi,
        ),
      ].map((match) => match[1]),
    )
    .map((value) => parseFloat(value.replace(/,/g, "")))
    .filter((value) => Number.isFinite(value) && value > 0);
  const amount = amountCandidates.length ? Math.max(...amountCandidates) : "";
  const dateMatch = text.match(
    /\b(\d{4}[-/]\d{1,2}[-/]\d{1,2}|\d{1,2}[-/]\d{1,2}[-/]\d{2,4})\b/,
  );
  const date = dateMatch ? normalizeReceiptDate(dateMatch[1]) : "";
  const lowerText = text.toLowerCase();
  let category = "Other";
  for (const [cat, keywords] of Object.entries(categoryMap)) {
    if (keywords.some((keyword) => lowerText.includes(keyword.toLowerCase()))) {
      category = cat;
      break;
    }
  }
  return { amount, date, category, note: titleCase(lines[0] || "Receipt") };
}

function normalizeReceiptDate(value) {
  const parts = value
    .replace(/\//g, "-")
    .split("-")
    .map((part) => part.padStart(2, "0"));
  if (parts[0].length === 4) return `${parts[0]}-${parts[1]}-${parts[2]}`;
  const year = parts[2].length === 2 ? `20${parts[2]}` : parts[2];
  return `${year}-${parts[1]}-${parts[0]}`;
}

function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];

    if (char === '"' && inQuotes && next === '"') {
      field += '"';
      i += 1;
    } else if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === "," && !inQuotes) {
      row.push(field.trim());
      field = "";
    } else if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && next === "\n") i += 1;
      row.push(field.trim());
      if (row.some(Boolean)) rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }

  row.push(field.trim());
  if (row.some(Boolean)) rows.push(row);
  return rows;
}

window.importData = (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  const isExcel = /\.(xlsx|xls)$/i.test(file.name);

  const reader = new FileReader();
  reader.onload = (loadEvent) => {
    try {
      const result = loadEvent.target.result;
      const imported = isExcel
        ? normalizeImportedExcel(result)
        : file.name.toLowerCase().endsWith(".json")
          ? normalizeImportedJSON(String(result || ""))
          : normalizeImportedCSV(String(result || ""));

      if (!imported.length) {
        alert("No valid transactions found in the file.");
        return;
      }

      if (confirm(`Parsed ${imported.length} transaction(s). Import now?`)) {
        window.state.expenses = [...window.state.expenses, ...imported];
        saveToLocal();
        updateCurrencyUI();
        updateUINotes();
        refresh();
      }
    } catch (error) {
      console.error("Import Error:", error);
      alert(
        "File format error. Use JSON backup or CSV columns: Date, Category, Note, Amount, Recurring.",
      );
    } finally {
      event.target.value = "";
    }
  };
  if (isExcel) reader.readAsArrayBuffer(file);
  else reader.readAsText(file);
};

function normalizeImportedExcel(buffer) {
  if (!window.XLSX) {
    alert(
      "Excel import library is unavailable. Check your connection and reload.",
    );
    return [];
  }
  const workbook = XLSX.read(buffer, { type: "array", cellDates: true });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });
  return normalizeExpenses(rows);
}

function normalizeImportedJSON(content) {
  const parsed = JSON.parse(content);
  if (!Array.isArray(parsed)) {
    if (typeof parsed.income === "number") window.state.income = parsed.income;
    if (typeof parsed.goal === "number") window.state.goal = parsed.goal;
    if (parsed.currency && currencySymbols[parsed.currency])
      window.state.currency = parsed.currency;
    if (parsed.categoryCaps && typeof parsed.categoryCaps === "object")
      window.state.categoryCaps = parsed.categoryCaps;
    if (Array.isArray(parsed.wallets))
      window.state.wallets = normalizeWallets(parsed.wallets);
    if (typeof parsed.budgetRating === "number")
      window.state.budgetRating = parsed.budgetRating;
  }
  return normalizeExpenses(
    Array.isArray(parsed) ? parsed : parsed.expenses || [],
  );
}

function normalizeImportedCSV(content) {
  const rows = parseCSV(content);
  const dataRows = rows[0]?.some((cell) =>
    /date|amount|category|note/i.test(cell),
  )
    ? rows.slice(1)
    : rows;
  return normalizeExpenses(
    dataRows.map((cols) => ({
      date: cols[0],
      cat: cols[1],
      note: cols[2],
      amt: cols[3],
      recurring: cols[4],
    })),
  );
}

function normalizeExpenses(items) {
  return items
    .map((item) => {
      const amount = parseFloat(
        item.amt ?? item.amount ?? item.Amount ?? item.Total ?? item.total,
      );
      const rawDate =
        item.date ??
        item.Date ??
        item.TransactionDate ??
        item["Transaction Date"] ??
        "";
      const date =
        rawDate instanceof Date
          ? rawDate.toISOString().slice(0, 10)
          : String(rawDate || "").slice(0, 10);
      if (!date || !Number.isFinite(amount) || amount <= 0) return null;
      const walletName = cleanTextInput(item.wallet ?? item.Wallet ?? "");
      const wallet = walletName
        ? window.state.wallets.find(
            (entry) => entry.name.toLowerCase() === walletName.toLowerCase(),
          )
        : null;
      return {
        id: Number(item.id) || Date.now() + Math.floor(Math.random() * 1000000),
        date,
        time: cleanTextInput(item.time ?? item.Time ?? ""),
        cat: cleanTextInput(
          item.cat ?? item.category ?? item.Category,
          "Other",
        ),
        note: cleanTextInput(item.note ?? item.Note, "Imported"),
        amt: amount,
        walletId: wallet?.id || item.walletId || getDefaultWalletId(),
        recurring: parseBoolean(item.recurring ?? item.Recurring),
      };
    })
    .filter(Boolean);
}

function parseBoolean(value) {
  if (typeof value === "boolean") return value;
  return /^(yes|true|1|recurring)$/i.test(String(value || "").trim());
}

window.enableEncryptedStorage = async () => {
  if (!window.crypto?.subtle) {
    alert(
      "Web Crypto is unavailable in this browser/context. Use HTTPS or localhost.",
    );
    return;
  }
  const passphrase = prompt(
    "Create an encryption passphrase. You need it every time this vault is opened.",
  );
  if (!passphrase || passphrase.length < 6) {
    alert("Use a passphrase with at least 6 characters.");
    return;
  }

  encryptionKey = await deriveEncryptionKey(passphrase);
  encryptedMode = true;
  await persistData();
  alert(
    "Encrypted storage is enabled. Keep the passphrase safe; it cannot be recovered.",
  );
};

window.disableEncryptedStorage = async () => {
  if (!encryptedMode) return;
  const passphrase = prompt(
    "Enter the encryption passphrase to move data back to plain localStorage.",
  );
  if (!passphrase) return;

  try {
    encryptionKey = await deriveEncryptionKey(
      passphrase,
      JSON.parse(localStorage.getItem(VAULT_KEY)).salt,
    );
    applyDataPayload(
      await decryptVault(localStorage.getItem(VAULT_KEY), encryptionKey),
    );
    encryptedMode = false;
    encryptionKey = null;
    localStorage.removeItem(VAULT_KEY);
    await persistData();
    alert("Encrypted storage has been disabled.");
  } catch (error) {
    console.error("Disable encryption failed:", error);
    alert("Wrong passphrase. Storage remains encrypted.");
  }
};

window.factoryReset = async () => {
  const verification = prompt(
    "Type RESET to wipe all local app data. This cannot be undone.",
  );
  if (verification !== "RESET") return;

  // 1. Clear all known localStorage keys
  [...STORAGE_KEYS, VAULT_KEY, RATE_CACHE_KEY, "theme"].forEach((key) =>
    localStorage.removeItem(key),
  );

  // 2. Clear ALL remaining keys (recurringReminder:* and any others)
  Object.keys(localStorage).forEach((key) => localStorage.removeItem(key));

  // 3. Delete IndexedDB database (holds full app state backup)
  await new Promise((resolve) => {
    try {
      const req = indexedDB.deleteDatabase(IDB_NAME);
      req.onsuccess = resolve;
      req.onerror = resolve;
      req.onblocked = resolve;
    } catch (e) {
      resolve();
    }
  });

  // 4. Unregister service worker and clear its caches so cached state is gone too
  if ("serviceWorker" in navigator) {
    const registrations = await navigator.serviceWorker
      .getRegistrations()
      .catch(() => []);
    await Promise.all(registrations.map((r) => r.unregister().catch(() => {})));
  }
  if ("caches" in window) {
    const cacheNames = await caches.keys().catch(() => []);
    await Promise.all(
      cacheNames.map((name) => caches.delete(name).catch(() => {})),
    );
  }

  location.reload();
};

// ── Mobile hamburger menu ──────────────────────────────────────────
window.toggleMobileMenu = function () {
  const isOpen = document.body.classList.toggle("mobile-menu-open");
  const btn = document.getElementById("hamburger-btn");
  if (btn) btn.setAttribute("aria-expanded", String(isOpen));
};

window.closeMobileMenu = function () {
  document.body.classList.remove("mobile-menu-open");
  const btn = document.getElementById("hamburger-btn");
  if (btn) btn.setAttribute("aria-expanded", "false");
};

// Close on Escape key
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") window.closeMobileMenu();
});

// Auto-close when viewport goes back to desktop size
window.matchMedia("(max-width: 768px)").addEventListener("change", (e) => {
  if (!e.matches) window.closeMobileMenu();
});

window.toggleTheme = () => {
  const currentTheme =
    document.body.dataset.theme === "dark" ? "dark" : "light";
  const nextTheme = currentTheme === "dark" ? "light" : "dark";
  document.body.dataset.theme = nextTheme;
  localStorage.setItem("theme", nextTheme);
  updateThemeButton();
};

function cleanTextInput(value, fallback = "") {
  if (value === undefined || value === null) return fallback;
  const sanitized = String(value)
    .replace(/<[^>]*>?/gm, "")
    .replace(/[^\p{L}\p{N} .,!?&()/_-]/gu, "")
    .trim();
  return sanitized || fallback;
}

function escapeHTML(value) {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (char) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[char],
  );
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function titleCase(value) {
  return String(value || "")
    .split(" ")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}


// ═══════════════════════════════════════════════════════════════
// ── FEATURE: SPENDING HEATMAP CALENDAR ─────────────────────────
// ═══════════════════════════════════════════════════════════════
function renderSpendingHeatmap() {
  const container = document.getElementById("spending-heatmap");
  const label = document.getElementById("heatmap-month-label");
  if (!container) return;

  const today = new Date();
  const offset = window.state.heatmapOffset || 0;
  const target = new Date(today.getFullYear(), today.getMonth() + offset, 1);
  const year = target.getFullYear();
  const month = target.getMonth();
  const monthKey = `${year}-${String(month + 1).padStart(2, "0")}`;

  if (label) {
    label.textContent = target.toLocaleDateString(undefined, {
      month: "long",
      year: "numeric",
    });
  }

  const dailyTotals = {};
  window.state.expenses
    .filter((e) => String(e.date || "").startsWith(monthKey))
    .forEach((e) => {
      dailyTotals[e.date] = (dailyTotals[e.date] || 0) + e.amt;
    });

  const values = Object.values(dailyTotals);
  const maxVal = values.length ? Math.max(...values) : 1;

  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const firstDay = new Date(year, month, 1).getDay();

  let html = '<div class="heatmap-dow-labels">';
  ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"].forEach((d) => {
    html += `<span>${d}</span>`;
  });
  html += '</div><div class="heatmap-grid">';

  for (let i = 0; i < firstDay; i += 1) {
    html += '<span class="heatmap-cell heat-empty"></span>';
  }

  for (let d = 1; d <= daysInMonth; d += 1) {
    const dateStr = `${monthKey}-${String(d).padStart(2, "0")}`;
    const amt = dailyTotals[dateStr] || 0;
    const level = amt === 0 ? 0 : Math.ceil((amt / maxVal) * 4);
    const isToday = dateStr === today.toISOString().slice(0, 10);
    html += `<span class="heatmap-cell heat-${level}${isToday ? " heatmap-today" : ""}" title="${dateStr}: ${formatMoney(amt, 0)}">${d}</span>`;
  }
  html += "</div>";
  container.innerHTML = html;
}

window.heatmapNav = (dir) => {
  window.state.heatmapOffset = (window.state.heatmapOffset || 0) + dir;
  renderSpendingHeatmap();
};

// ═══════════════════════════════════════════════════════════════
// ── FEATURE: AI-POWERED ANOMALY DETECTION ──────────────────────
// ═══════════════════════════════════════════════════════════════
function detectAnomalies() {
  const strip = document.getElementById("anomaly-strip");
  if (!strip) return;

  const catTotals = {};
  const catCounts = {};
  window.state.expenses.forEach((e) => {
    catTotals[e.cat] = (catTotals[e.cat] || 0) + e.amt;
    catCounts[e.cat] = (catCounts[e.cat] || 0) + 1;
  });

  const catAverages = {};
  Object.keys(catTotals).forEach((c) => {
    catAverages[c] = catTotals[c] / catCounts[c];
  });

  const anomalies = window.state.expenses
    .filter((e) => {
      const avg = catAverages[e.cat];
      return avg && e.amt > avg * 2.5 && e.amt > 200;
    })
    .sort((a, b) => b.id - a.id)
    .slice(0, 3);

  if (!anomalies.length) {
    strip.style.display = "none";
    strip.innerHTML = "";
    return;
  }

  strip.style.display = "block";
  strip.innerHTML =
    `<div class="anomaly-header">⚠ Unusual transactions detected</div>` +
    anomalies
      .map((e) => {
        const avg = catAverages[e.cat];
        const pct = Math.round((e.amt / avg - 1) * 100);
        return `<div class="anomaly-item"><span class="anomaly-dot"></span><b>${escapeHTML(e.note || e.cat)}</b> — ${formatMoney(e.amt)} is <b>${pct}% above</b> your average for ${escapeHTML(e.cat)} (avg ${formatMoney(avg, 0)})</div>`;
      })
      .join("");
}

// ═══════════════════════════════════════════════════════════════
// ── FEATURE: MONTHLY BUDGET AUTO-RESET (carry-forward balance) ─
// ═══════════════════════════════════════════════════════════════
function checkMonthlyAutoReset() {
  if (localStorage.getItem("autoReset") !== "true") return;
  const currentMonth = new Date().toISOString().slice(0, 7);
  const lastReset = localStorage.getItem("lastAutoReset") || "";
  if (lastReset === currentMonth) return;
  runAutoReset(currentMonth);
}

function runAutoReset(monthKey) {
  const prevMonthKey = (() => {
    const d = new Date(`${monthKey}-01`);
    d.setMonth(d.getMonth() - 1);
    return d.toISOString().slice(0, 7);
  })();

  const prevExp = window.state.expenses
    .filter((e) => String(e.date || "").startsWith(prevMonthKey))
    .reduce((sum, e) => sum + e.amt, 0);
  const carryover = Math.max(0, window.state.income - prevExp);

  const bankWallet = window.state.wallets.find(
    (w) => w.id === "wallet-bank" || w.name.toLowerCase() === "bank",
  );
  if (bankWallet && carryover > 0) {
    bankWallet.balance += carryover;
    saveToLocal();
  }

  localStorage.setItem("lastAutoReset", monthKey);
  localStorage.setItem("lastCarryover", String(carryover));
  renderAutoResetStatus();
  refresh();
}

window.runManualReset = () => {
  if (
    !confirm(
      "Run a carry-forward reset now? Your previous month's remaining balance will be added to your Bank wallet.",
    )
  )
    return;
  const currentMonth = new Date().toISOString().slice(0, 7);
  runAutoReset(currentMonth);
  alert("✅ Carry-forward reset complete!");
};

function initAutoResetUI() {
  const toggle = document.getElementById("auto-reset-toggle");
  if (toggle) toggle.checked = localStorage.getItem("autoReset") === "true";
  renderAutoResetStatus();
}

window.toggleAutoReset = (val) => {
  localStorage.setItem("autoReset", String(val));
  renderAutoResetStatus();
};

function renderAutoResetStatus() {
  const box = document.getElementById("reset-status");
  if (!box) return;
  const last = localStorage.getItem("lastAutoReset") || "Never";
  const carryover = parseFloat(localStorage.getItem("lastCarryover") || "0");
  const enabled = localStorage.getItem("autoReset") === "true";
  box.innerHTML = `
    <p><b>Status:</b> ${enabled ? "✅ Enabled" : "⏸ Disabled"}</p>
    <p><b>Last reset:</b> ${escapeHTML(last)}</p>
    ${carryover > 0 ? `<p><b>Last carry-forward:</b> ${formatMoney(carryover)}</p>` : ""}
  `;
}

// ═══════════════════════════════════════════════════════════════
// ── FEATURE: SIP / INVESTMENT TRACKER ──────────────────────────
// ═══════════════════════════════════════════════════════════════
function initSIPTracker() {
  renderSIPList();
}

window.addSIP = () => {
  const name = cleanTextInput(document.getElementById("sip-name")?.value);
  const type = document.getElementById("sip-type")?.value || "SIP";
  const amount = parseFloat(document.getElementById("sip-amount")?.value);
  const returns =
    parseFloat(document.getElementById("sip-returns")?.value) || 0;
  const start =
    document.getElementById("sip-start")?.value ||
    new Date().toISOString().slice(0, 10);
  const tenure =
    parseInt(document.getElementById("sip-tenure")?.value, 10) || 12;

  if (!name) {
    alert("Enter a fund / FD / RD name.");
    return;
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    alert("Enter a valid invested amount.");
    return;
  }

  const sips = safeJSONParse(localStorage.getItem("sips"), []);
  sips.push({ id: Date.now(), name, type, amount, returns, start, tenure });
  localStorage.setItem("sips", JSON.stringify(sips));

  ["sip-name", "sip-amount", "sip-returns", "sip-start", "sip-tenure"].forEach(
    (id) => {
      const el = document.getElementById(id);
      if (el) el.value = "";
    },
  );
  renderSIPList();
};

window.deleteSIP = (id) => {
  if (!confirm("Remove this investment entry?")) return;
  const sips = safeJSONParse(localStorage.getItem("sips"), []).filter(
    (s) => s.id !== id,
  );
  localStorage.setItem("sips", JSON.stringify(sips));
  renderSIPList();
};

function renderSIPList() {
  const box = document.getElementById("sip-list");
  if (!box) return;
  const sips = safeJSONParse(localStorage.getItem("sips"), []);
  if (!sips.length) {
    box.innerHTML = '<p class="empty-note">No investments logged yet.</p>';
    return;
  }

  let totalInvested = 0;
  let totalMaturity = 0;

  const rows = sips
    .map((inv) => {
      const r = inv.returns / 100 / 12;
      const n = inv.tenure;
      const maturity =
        r > 0
          ? inv.amount * ((Math.pow(1 + r, n) - 1) / r) * (1 + r)
          : inv.amount * n;
      const invested = inv.amount * n;
      const gain = maturity - invested;
      totalInvested += invested;
      totalMaturity += maturity;

      return `
      <div class="sip-item">
        <div class="sip-row-top">
          <span class="sip-type-badge">${escapeHTML(inv.type)}</span>
          <b>${escapeHTML(inv.name)}</b>
          <b class="sip-amt">${formatMoney(inv.amount)}/mo</b>
        </div>
        <div class="sip-details">
          <span>${inv.tenure}m @ ${inv.returns}% p.a.</span>
          <span>Maturity: <b>${formatMoney(maturity, 0)}</b></span>
          <span class="sip-gain">+${formatMoney(gain, 0)} gain</span>
        </div>
        <button type="button" class="link-danger" data-sip-del="${inv.id}">Remove</button>
      </div>`;
    })
    .join("");

  box.innerHTML =
    rows +
    `<div class="sip-summary">
      <span>Total Invested: <b>${formatMoney(totalInvested, 0)}</b></span>
      <span>Est. Corpus: <b>${formatMoney(totalMaturity, 0)}</b></span>
    </div>`;

  box.querySelectorAll("[data-sip-del]").forEach((btn) => {
    btn.addEventListener("click", () =>
      window.deleteSIP(Number(btn.dataset.sipDel)),
    );
  });
}

// ═══════════════════════════════════════════════════════════════
// ── FEATURE: BUDGET LOCK MODE ───────────────────────────────────
// ═══════════════════════════════════════════════════════════════
function initBudgetLockUI() {
  const toggle = document.getElementById("budget-lock-mode");
  if (toggle) toggle.checked = window.state.budgetLock;
}

window.toggleBudgetLock = (val) => {
  window.state.budgetLock = val;
  localStorage.setItem("budgetLock", String(val));
  renderCategoryCaps();
};

window.unfreezeCategory = (cat) => {
  const current = window.state.categoryCaps[cat] || 0;
  const input = prompt(
    `"${cat}" is locked. Enter a new (higher) limit to unfreeze it:`,
    String(current),
  );
  if (input === null) return;
  const newLimit = parseFloat(input);
  if (!Number.isFinite(newLimit) || newLimit <= 0) {
    alert("Enter a valid limit amount.");
    return;
  }
  window.state.categoryCaps[cat] = newLimit;
  saveToLocal();
  renderCategoryCaps();
};

// ═══════════════════════════════════════════════════════════════
// ── FEATURE: MONTHLY REPORT VIA EMAILJS (with PDF attachment) ──
// ═══════════════════════════════════════════════════════════════
function initEmailConfigUI() {
  const cfg = safeJSONParse(localStorage.getItem("emailjsConfig"), {});
  const serviceEl = document.getElementById("emailjs-service");
  const templateEl = document.getElementById("emailjs-template");
  const pubkeyEl = document.getElementById("emailjs-pubkey");
  const emailEl = document.getElementById("report-email");
  if (serviceEl && cfg.serviceId) serviceEl.value = cfg.serviceId;
  if (templateEl && cfg.templateId) templateEl.value = cfg.templateId;
  if (pubkeyEl && cfg.pubKey) pubkeyEl.value = cfg.pubKey;
  if (emailEl && cfg.email) emailEl.value = cfg.email;

  const autoEl = document.getElementById("auto-email-month-end");
  if (autoEl) autoEl.checked = localStorage.getItem("autoEmailEnd") === "true";
}

window.saveEmailConfig = () => {
  const existing = safeJSONParse(localStorage.getItem("emailjsConfig"), {});
  const cfg = {
    ...existing,
    serviceId: cleanTextInput(document.getElementById("emailjs-service")?.value),
    templateId: cleanTextInput(document.getElementById("emailjs-template")?.value),
    pubKey: cleanTextInput(document.getElementById("emailjs-pubkey")?.value),
    email: document.getElementById("report-email")?.value?.trim() || existing.email || "",
  };
  localStorage.setItem("emailjsConfig", JSON.stringify(cfg));
  const status = document.getElementById("email-status");
  if (status) status.textContent = "Email service setup saved on this device.";
};

window.saveReportEmail = () => {
  const email = document.getElementById("report-email")?.value?.trim() || "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    const status = document.getElementById("email-status");
    if (status) status.textContent = "Please enter a valid email address.";
    return;
  }
  const cfg = safeJSONParse(localStorage.getItem("emailjsConfig"), {});
  cfg.email = email;
  localStorage.setItem("emailjsConfig", JSON.stringify(cfg));
  const status = document.getElementById("email-status");
  if (status) status.textContent = "Email address saved on this device. You can now send your report.";
};

window.toggleAutoEmail = (val) => {
  localStorage.setItem("autoEmailEnd", String(val));
};

async function sendMonthlyReport(isAuto = false) {
  const cfg = safeJSONParse(localStorage.getItem("emailjsConfig"), {});
  const enteredEmail = document.getElementById("report-email")?.value?.trim();
  if (enteredEmail) {
    cfg.email = enteredEmail;
    localStorage.setItem("emailjsConfig", JSON.stringify(cfg));
  }
  if (!isAuto && !cfg.email) {
    const status = document.getElementById("email-status");
    if (status) status.textContent = "Enter your email address first.";
    document.getElementById("report-email")?.focus();
    return { success: false, error: "Email address is required." };
  }

  // ─────────────────────────────────────────────
  // Validate EmailJS configuration
  // ─────────────────────────────────────────────
  if (!cfg?.pubKey || !cfg?.serviceId || !cfg?.templateId) {
    if (!isAuto) {
      alert(
        "EmailJS is not configured yet. Please enter your Public Key, Service ID, and Template ID in Settings.",
      );
    }

    console.error(
      "Monthly Report Email failed: EmailJS configuration is incomplete.",
    );

    return {
      success: false,
      error: "EmailJS configuration is incomplete.",
    };
  }

  if (typeof emailjs === "undefined") {
    if (!isAuto) {
      alert(
        "Email service is unavailable. Check your internet connection and reload the application.",
      );
    }

    console.error(
      "Monthly Report Email failed: EmailJS library is unavailable.",
    );

    return {
      success: false,
      error: "EmailJS library unavailable.",
    };
  }

  try {
    // ─────────────────────────────────────────────
    // Initialize EmailJS
    // ─────────────────────────────────────────────
    emailjs.init({
      publicKey: cfg.pubKey,
    });

    // ─────────────────────────────────────────────
    // Current month
    // ─────────────────────────────────────────────
    const now = new Date();

    const monthKey = `${now.getFullYear()}-${String(
      now.getMonth() + 1,
    ).padStart(2, "0")}`;

    const monthName = now.toLocaleDateString(undefined, {
      month: "long",
      year: "numeric",
    });

    // ─────────────────────────────────────────────
    // Get this month's transactions
    // ─────────────────────────────────────────────
    const monthExpenses = (window.state?.expenses || []).filter((e) => {
      if (!e.date) return false;

      return e.date.startsWith(monthKey);
    });

    const totalSpent = monthExpenses.reduce(
      (sum, e) => sum + Number(e.amt || 0),
      0,
    );

    const income = Number(window.state?.income || 0);

    const balance = income - totalSpent;

    // ─────────────────────────────────────────────
    // Category breakdown
    // ─────────────────────────────────────────────
    const catBreakdown = {};

    monthExpenses.forEach((e) => {
      const category = e.cat || "Uncategorized";

      catBreakdown[category] =
        (catBreakdown[category] || 0) + Number(e.amt || 0);
    });

    const categoryBreakdown =
      Object.entries(catBreakdown)
        .sort((a, b) => b[1] - a[1])
        .map(([category, amount]) => `${category}: ${formatMoney(amount)}`)
        .join("\n") || "No spending recorded";

    // ─────────────────────────────────────────────
    // Email parameters
    // ─────────────────────────────────────────────
    const params = {
      to_email: cfg.email,

      month: monthName,

      income: formatMoney(income),

      total_spent: formatMoney(totalSpent),

      balance: formatMoney(balance),

      category_breakdown: categoryBreakdown,

      transactions_count: monthExpenses.length,
    };

    console.log("Sending Monthly Report Email...", params);

    // ─────────────────────────────────────────────
    // Send email
    // ─────────────────────────────────────────────
    const response = await emailjs.send(cfg.serviceId, cfg.templateId, params);

    console.log("Monthly Report Email sent successfully:", response);

    // ─────────────────────────────────────────────
    // SUCCESS
    // ─────────────────────────────────────────────
    if (!isAuto) {
      alert(`Monthly report for ${monthName} was sent successfully.`);
    }

    return {
      success: true,
      response,
      monthKey,
    };
  } catch (err) {
    // ─────────────────────────────────────────────
    // FAILURE
    // ─────────────────────────────────────────────
    console.error("Monthly Report Email failed:", err);

    if (!isAuto) {
      alert(
        "The monthly report could not be sent.\n\n" +
          "Please check your EmailJS settings and internet connection, then try again.",
      );
    }

    return {
      success: false,
      error: err,
    };
  }
}

window.sendMonthlyReport = sendMonthlyReport;

async function checkAutoEmailEnd() {
  const settings = safeJSONParse(localStorage.getItem("emailjsConfig"), {});
  const autoSend = localStorage.getItem("autoEmailEnd") === "true";

  if (!autoSend || !settings?.serviceId || !settings?.templateId || !settings?.pubKey || !settings?.email) {
    return;
  }

  const today = new Date();

  // ─────────────────────────────────────────────
  // Check whether today is the last day of month
  // ─────────────────────────────────────────────
  const tomorrow = new Date(today);

  tomorrow.setDate(today.getDate() + 1);

  const isLastDay = tomorrow.getMonth() !== today.getMonth();

  if (!isLastDay) {
    return;
  }

  // ─────────────────────────────────────────────
  // Unique key for this month's automatic email
  // ─────────────────────────────────────────────
  const monthKey = `${today.getFullYear()}-${String(
    today.getMonth() + 1,
  ).padStart(2, "0")}`;

  const sentKey = `autoEmailSent:${monthKey}`;

  // Already successfully sent
  if (localStorage.getItem(sentKey) === "1") {
    console.log(`Monthly report for ${monthKey} was already sent.`);

    return;
  }

  console.log(`Attempting automatic monthly report for ${monthKey}...`);

  // ─────────────────────────────────────────────
  // IMPORTANT:
  // Do NOT mark it as sent yet.
  // ─────────────────────────────────────────────
  const result = await sendMonthlyReport(true);

  // ─────────────────────────────────────────────
  // Only mark as sent AFTER EmailJS succeeds
  // ─────────────────────────────────────────────
  if (result?.success) {
    localStorage.setItem(sentKey, "1");

    console.log(`Automatic monthly report successfully sent for ${monthKey}.`);
  } else {
    // Make absolutely sure a failed attempt
    // does not permanently block a retry.
    localStorage.removeItem(sentKey);

    console.warn(
      `Automatic monthly report failed for ${monthKey}. It can be retried.`,
    );
  }
}

// ═══════════════════════════════════════════════════════════════
// ── FEATURE: WEB PUSH NOTIFICATIONS (browser Notification API) ─
// ═══════════════════════════════════════════════════════════════
function initPushNotificationUI() {
  const btn = document.getElementById("push-subscribe-btn");
  const status = document.getElementById("push-status");
  if (!("Notification" in window)) {
    if (status)
      status.textContent =
        "Push notifications aren't supported in this browser.";
    if (btn) btn.disabled = true;
    return;
  }
  if (Notification.permission === "granted") {
    if (status) status.textContent = "✅ Notifications are enabled.";
    if (btn) btn.textContent = "🔔 Notifications On";
  } else if (Notification.permission === "denied") {
    if (status)
      status.textContent =
        "❌ Blocked — allow notifications in your browser settings.";
    if (btn) btn.disabled = true;
  }
}

window.subscribeToPushNotifications = async () => {
  const status = document.getElementById("push-status");
  const btn = document.getElementById("push-subscribe-btn");

  if (!("Notification" in window)) {
    if (status) status.textContent = "Push isn't supported in this browser.";
    return;
  }

  try {
    const permission = await Notification.requestPermission();
    if (permission === "granted") {
      if (status)
        status.textContent =
          "✅ Notifications enabled — you'll get budget reminders.";
      if (btn) btn.textContent = "🔔 Notifications On";
      new Notification("Smart Budget Tracker", {
        body: "Push notifications are now active. You'll be alerted for budget reminders.",
        icon: "https://cdn-icons-png.flaticon.com/512/2454/2454261.png",
      });
      localStorage.setItem("pushEnabled", "true");
    } else if (status) {
      status.textContent = "❌ Notification permission denied.";
    }
  } catch (err) {
    console.error("Push subscription error:", err);
    if (status) status.textContent = "❌ Error enabling notifications.";
  }
};

function fireNotification(title, body) {
  if (!("Notification" in window) || Notification.permission !== "granted")
    return;
  try {
    new Notification(title, {
      body,
      icon: "https://cdn-icons-png.flaticon.com/512/2454/2454261.png",
    });
  } catch (e) {
    /* some browsers restrict direct Notification outside a service worker */
  }
}

let deferredPrompt = null;
const installContainer = document.getElementById("pwa-install-container");
const installBtn = document.getElementById("btn-pwa-install");

/*
// COMMENTED OUT FOR LATER PWA RE-ENABLEMENT:

window.addEventListener("beforeinstallprompt", (e) => {
  // Prevent standard default browser mini-infobar prompt from sliding up automatically
  e.preventDefault();

  // Stash the event intercept configuration so it can be triggered later on click
  deferredPrompt = e;

  // Unhide your beautiful native installation interface panel
  if (installContainer) {
    installContainer.style.display = "flex";
  }
});

if (installBtn) {
  installBtn.addEventListener("click", async () => {
    if (!deferredPrompt) return;

    // Show the browser secure system installer overlay panel window
    deferredPrompt.prompt();

    // Await user confirmation choice response selection (Accepted vs Dismissed)
    const { outcome } = await deferredPrompt.userChoice;
    console.log(`User installation decision choice outcome: ${outcome}`);

    // Clear out the temporary snapshot variable memory resource pool
    deferredPrompt = null;

    // Hide the banner container choice layout block securely since action is fulfilled
    if (installContainer) {
      installContainer.style.display = "none";
    }
  });
}

// Hide container window automatically once the web app installation is successfully finished
window.addEventListener("appinstalled", (event) => {
  console.log(
    "Budget Tracker was successfully installed onto device shell drawer!",
  );
  if (installContainer) {
    installContainer.style.display = "none";
  }
  deferredPrompt = null;
});

*/
