"use strict";

/**
 * Submits the dashboard password to the same-origin login endpoint and moves
 * the browser to the protected dashboard after the HttpOnly session cookie is
 * issued. The password is never logged, persisted, or inserted into markup.
 *
 * @param {SubmitEvent} event Login form submission event.
 * @returns {Promise<void>} Resolves after the login attempt is rendered.
 */
async function handleLoginSubmit(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const passwordInput = form.elements.namedItem("password");
  const submitButton = document.getElementById("login-submit");
  const feedback = document.getElementById("login-feedback");
  const password = passwordInput.value;

  if (!password) {
    feedback.textContent = "Enter the dashboard password.";
    feedback.classList.add("is-error");
    passwordInput.focus();
    return;
  }

  submitButton.disabled = true;
  submitButton.textContent = "Signing in…";
  feedback.textContent = "";
  feedback.classList.remove("is-error");

  try {
    const response = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
      cache: "no-store",
      credentials: "same-origin",
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || "Sign-in failed.");
    }
    window.location.replace("/");
  } catch (error) {
    feedback.textContent = error instanceof Error ? error.message : "Sign-in failed.";
    feedback.classList.add("is-error");
    passwordInput.select();
  } finally {
    submitButton.disabled = false;
    submitButton.textContent = "Sign in";
  }
}

/**
 * Wires the single login form after the deferred script has loaded. Missing
 * markup is treated as a no-op so a future static-page change cannot create a
 * page-wide uncaught exception.
 *
 * @returns {void}
 */
function initializeLoginPage() {
  const form = document.getElementById("login-form");
  if (form) {
    form.addEventListener("submit", handleLoginSubmit);
  }
}

document.addEventListener("DOMContentLoaded", initializeLoginPage);
