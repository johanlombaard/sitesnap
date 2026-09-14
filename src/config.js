// One-time setup: register an OAuth App (not a GitHub App — spec §2.2) at
// https://github.com/settings/developers, scope doesn't matter at
// registration time (Device Flow requests `gist` at runtime), homepage URL
// and callback URL can both be anything (Device Flow never redirects).
// Paste the resulting Client ID below. It is not a secret — it ships in the
// extension (spec §8) — but it is specific to your registration.
export const GITHUB_CLIENT_ID = 'Ov23lizacGaUJsDvcHsG';
