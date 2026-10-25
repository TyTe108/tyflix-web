// JSON request-body parser mounted in index.ts immediately after Helmet.
// Inflation is disabled so compressed request bodies are refused before they
// reach decoder paths implicated by CVE-2026-111497 and CVE-2026-111181.

import express from "express";

/** The application's JSON parser, configured to reject compressed request bodies. */
export const jsonBody = express.json({ inflate: false });
