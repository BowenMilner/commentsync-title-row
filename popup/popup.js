async function getActiveState() {
  const state = await browser.storage.sync.get("active");

  if (state?.active === undefined || state?.active === null) {
    await browser.storage.sync.set({ active: true });
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
  const isActive = await getActiveState();

  setToggleState(toggle, isActive);

  toggle.addEventListener("click", async () => {
    const nextState = !toggle.classList.contains("toggle_active");

    setToggleState(toggle, nextState);
    await browser.storage.sync.set({ active: nextState });
    await browser.runtime.sendMessage({ type: "isActive", status: nextState });
  });
});
