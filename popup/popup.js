const extensionApi = globalThis.browser || globalThis.chrome;
const usingBrowserPromiseApi = Boolean(globalThis.browser);

async function getActiveState() {
  const state = await getSyncStorage("active");

  if (state?.active === undefined || state?.active === null) {
    await setSyncStorage({ active: true });
    return true;
  }

  return state.active;
}

function setToggleState(toggle, isActive) {
  toggle.classList.toggle("toggle_active", isActive);
  toggle.setAttribute("aria-checked", String(isActive));
}

document.addEventListener("DOMContentLoaded", async () => {
  const toggle = document.getElementById("togglebtn");
  let isActive = true;

  try {
    isActive = await getActiveState();
  } catch (error) {
    console.error("CommentSync Title Row failed to read the active state", error);
  }

  setToggleState(toggle, isActive);

  toggle.addEventListener("click", async () => {
    const previousState = toggle.classList.contains("toggle_active");
    const nextState = !toggle.classList.contains("toggle_active");
    setToggleState(toggle, nextState);
    toggle.disabled = true;

    try {
      await setSyncStorage({ active: nextState });
    } catch (error) {
      console.error("CommentSync Title Row failed to save the active state", error);
      setToggleState(toggle, previousState);
    } finally {
      toggle.disabled = false;
      toggle.focus();
    }
  });
});

function getSyncStorage(keys) {
  if (usingBrowserPromiseApi) {
    return extensionApi.storage.sync.get(keys);
  }

  return new Promise((resolve, reject) => {
    extensionApi.storage.sync.get(keys, (items) => {
      const error = extensionApi.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(items);
    });
  });
}

function setSyncStorage(items) {
  if (usingBrowserPromiseApi) {
    return extensionApi.storage.sync.set(items);
  }

  return new Promise((resolve, reject) => {
    extensionApi.storage.sync.set(items, () => {
      const error = extensionApi.runtime.lastError;

      if (error) {
        reject(new Error(error.message));
        return;
      }

      resolve();
    });
  });
}
