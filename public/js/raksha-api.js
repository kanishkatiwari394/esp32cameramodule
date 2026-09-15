// Raksha Rail - shared browser helpers for talking to the Vercel API.
// Frontend and API are served from the same Vercel domain, so every call is same-origin
// ("/api/..."): no localhost, no hard-coded host, and the session cookie is sent automatically.
(function () {
    "use strict";

    var LOGIN_PAGE = "index.html";
    // Optional override if the API is ever hosted on a different origin: window.RAKSHA_CONFIG = { apiBase: "https://..." }
    var API_BASE = (window.RAKSHA_CONFIG && window.RAKSHA_CONFIG.apiBase) || "";

    async function request(path, options) {
        options = options || {};
        var init = {
            method: options.method || "GET",
            credentials: "same-origin",
            cache: "no-store",
            headers: { "Accept": "application/json" }
        };
        if (options.body !== undefined) {
            init.headers["Content-Type"] = "application/json";
            init.body = JSON.stringify(options.body);
        }

        var response;
        try {
            response = await fetch(API_BASE + path, init);
        } catch (networkError) {
            var offline = new Error("Network error - check your internet connection");
            offline.status = 0;
            throw offline;
        }

        var text = await response.text();
        var data = null;
        if (text) {
            try { data = JSON.parse(text); } catch (parseError) { data = null; }
        }

        if (!response.ok) {
            if (response.status === 401 && options.redirectOnUnauthorized !== false) {
                window.location.replace(LOGIN_PAGE);
            }
            var error = new Error((data && data.error) || ("Request failed (" + response.status + ")"));
            error.status = response.status;
            error.data = data;
            throw error;
        }
        return data;
    }

    /** Protected pages call this first. Unauthenticated visitors are sent to the login page. */
    async function requireSession() {
        try {
            var data = await request("/api/auth/me");
            document.documentElement.classList.remove("auth-pending");
            return data.user;
        } catch (error) {
            if (error.status === 401) {
                return new Promise(function () {}); // redirect already in progress
            }
            document.documentElement.classList.remove("auth-pending");
            throw error;
        }
    }

    async function logout(event) {
        if (event) event.preventDefault();
        try {
            await request("/api/auth/logout", { method: "POST", redirectOnUnauthorized: false });
        } catch (error) {
            // Even if the request fails, leave the protected page.
        }
        window.location.replace(LOGIN_PAGE);
    }

    function formatDateTime(iso) {
        if (!iso) return "--";
        var date = new Date(iso);
        return isNaN(date.getTime()) ? "--" : date.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "medium" });
    }

    function formatTime(iso) {
        if (!iso) return "--";
        var date = new Date(iso);
        return isNaN(date.getTime()) ? "--" : date.toLocaleTimeString("en-IN");
    }

    function timeAgo(iso) {
        if (!iso) return "--";
        var seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
        if (!isFinite(seconds)) return "--";
        if (seconds < 5) return "just now";
        if (seconds < 60) return seconds + "s ago";
        if (seconds < 3600) return Math.floor(seconds / 60) + " min ago";
        if (seconds < 86400) return Math.floor(seconds / 3600) + " h ago";
        return Math.floor(seconds / 86400) + " d ago";
    }

    function threatColor(status) {
        switch (status) {
            case "PENDING": return "#b45309";
            case "CLEAR": return "#16a34a";
            case "SUSPICIOUS": return "#e86f00";
            case "THREAT": return "#c62828";
            default: return "#123b59";
        }
    }

    /** Runs fn now and every intervalMs; pauses while the tab is hidden to save API calls. */
    function startPolling(fn, intervalMs) {
        var timer = null;
        var running = false;
        var stopped = false;

        async function tick() {
            if (running || stopped) return;
            running = true;
            try { await fn(); } finally { running = false; }
        }
        function schedule() {
            clearInterval(timer);
            timer = setInterval(tick, intervalMs);
        }

        document.addEventListener("visibilitychange", function () {
            if (document.hidden) {
                clearInterval(timer);
                timer = null;
            } else if (!stopped) {
                tick();
                schedule();
            }
        });

        tick();
        schedule();

        return {
            stop: function () { stopped = true; clearInterval(timer); timer = null; },
            resume: function () { stopped = false; tick(); schedule(); },
            get paused() { return stopped; }
        };
    }

    window.RakshaApi = {
        request: request,
        requireSession: requireSession,
        logout: logout,
        formatDateTime: formatDateTime,
        formatTime: formatTime,
        timeAgo: timeAgo,
        threatColor: threatColor,
        startPolling: startPolling
    };
})();
