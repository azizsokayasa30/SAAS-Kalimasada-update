/**
 * kalimasada Zero-FOUC Theme Switcher Engine
 * Automatically blocks screen until theme is evaluated.
 */

(function() {
    'use strict';
  
    // 1. Initialize Sync - MUST run before body
    const STORAGE_KEY = 'kalimasada_theme';
    let currentTheme = localStorage.getItem(STORAGE_KEY);
  
    if (!currentTheme) {
      // Fallback
      currentTheme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
  
    // Enforce HTML attribute instantly
    document.documentElement.setAttribute('data-theme', currentTheme);
  
    // 2. Global Actions
    window.toggleTheme = function() {
      currentTheme = (currentTheme === 'light') ? 'dark' : 'light';
      document.documentElement.setAttribute('data-theme', currentTheme);
      localStorage.setItem(STORAGE_KEY, currentTheme);
  
      // Sync all UI toggles
      syncToggleUI(true);
    };
  
    window.getCurrentTheme = function() {
      return currentTheme;
    };
  
    // 3. UI Synchronization
    function syncToggleUI(animate) {
      // Header Icon
      const headerIcon = document.getElementById('headerThemeIcon');
      if (headerIcon) {
        headerIcon.className = currentTheme === 'dark' ? 'bi bi-sun-fill' : 'bi bi-moon-fill';
      }
      
      // Sidebar Icon/Label (from theme-toggle.ejs part)
      const sidebarIcon = document.getElementById('themeToggleIcon');
      const sidebarLabel = document.getElementById('themeToggleLabel');
      
      if (sidebarIcon) {
        sidebarIcon.className = currentTheme === 'dark' ? 'bi bi-moon-fill' : 'bi bi-sun-fill';
        sidebarIcon.style.transform = '';
        if (animate) {
          sidebarIcon.style.transform = 'rotate(360deg) scale(1.3)';
          setTimeout(() => { sidebarIcon.style.transform = ''; }, 400);
        }
      }
      
      if (sidebarLabel) {
        sidebarLabel.textContent = currentTheme === 'dark' ? 'Tema Gelap' : 'Tema Terang';
      }
    }
  
    // 4. Bind Listeners on DOMContentLoaded
    document.addEventListener('DOMContentLoaded', () => {
      syncToggleUI(false);
      
      const headerBtn = document.getElementById('btnHeaderThemeToggle');
      if (headerBtn) {
        headerBtn.addEventListener('click', (e) => {
          e.preventDefault();
          window.toggleTheme();
        });
      }
  
      const sidebarBtn = document.getElementById('globalThemeToggle');
      if (sidebarBtn) {
        sidebarBtn.addEventListener('click', (e) => {
          e.preventDefault();
          window.toggleTheme();
        });
      }
    });
  
    // Listen to changes across tabs
    window.addEventListener('storage', function(e) {
      if (e.key === STORAGE_KEY && e.newValue) {
        currentTheme = e.newValue;
        document.documentElement.setAttribute('data-theme', currentTheme);
        syncToggleUI(false);
      }
    });
  })();
