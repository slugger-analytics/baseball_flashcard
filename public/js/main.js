/**
 * main.js — starts the app. Loaded last.
 */

'use strict';

let app;
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {app =  new FlashcardApp(document.getElementById('app')); });
} else {
  app = new FlashcardApp(document.getElementById('app'));
}

// MOBILE FIX: CONVERT HOVER TOOLTIPS TO TAPS
document.addEventListener('click', (e) => {
  // If the user taps something that has a tooltip message...
  if (e.target && e.target.hasAttribute('title')) {
    // And if it's an info span or an emoji...
    if (e.target.tagName === 'SPAN' || e.target.textContent.includes('ⓘ') || e.target.textContent.includes('🔒')) {
      // Prevent any other button clicks and show the message!
      e.preventDefault();
      alert(e.target.getAttribute('title'));
    }
  }
});
