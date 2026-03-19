import { defineConfig } from "vitepress";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  title: "OpenWolf",
  description:
    "Token-conscious AI brain for Claude Code — invisible middleware that saves tokens, learns preferences, and prevents mistakes",
  head: [
    ["link", { rel: "icon", type: "image/svg+xml", href: "/wolf.svg" }],
    [
      "link",
      {
        rel: "preconnect",
        href: "https://fonts.googleapis.com",
      },
    ],
    [
      "link",
      {
        rel: "preconnect",
        href: "https://fonts.gstatic.com",
        crossorigin: "",
      },
    ],
    [
      "link",
      {
        rel: "stylesheet",
        href: "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&family=JetBrains+Mono:wght@400;500;600;700&display=swap",
      },
    ],
    [
      "meta",
      {
        property: "og:title",
        content: "OpenWolf — Token-Conscious AI Brain for Claude Code",
      },
    ],
    [
      "meta",
      {
        property: "og:description",
        content:
          "Invisible middleware that makes Claude Code smarter. Zero extra AI cost.",
      },
    ],
  ],
  vite: {
    plugins: [tailwindcss()],
  },
  themeConfig: {
    logo: "/wolf.svg",
    siteTitle: "OpenWolf",
    nav: [
      { text: "Guide", link: "/getting-started" },
      { text: "How It Works", link: "/how-it-works" },
      { text: "Commands", link: "/commands" },
      { text: "Config", link: "/configuration" },
    ],
    sidebar: [
      {
        text: "Introduction",
        items: [
          { text: "What is OpenWolf?", link: "/" },
          { text: "Getting Started", link: "/getting-started" },
        ],
      },
      {
        text: "Core Concepts",
        items: [
          { text: "How It Works", link: "/how-it-works" },
          { text: "Hooks", link: "/hooks" },
          { text: "Dashboard", link: "/dashboard" },
        ],
      },
      {
        text: "Features",
        items: [
          { text: "Design QC", link: "/designqc" },
          { text: "Reframe", link: "/reframe" },
        ],
      },
      {
        text: "Reference",
        items: [
          { text: "Commands", link: "/commands" },
          { text: "Configuration", link: "/configuration" },
          { text: "Update & Restore", link: "/updating" },
          { text: "Troubleshooting", link: "/troubleshooting" },
        ],
      },
    ],
    socialLinks: [
      { icon: "github", link: "https://github.com/cytostack/openwolf" },
    ],
    footer: {
      message: "AGPL-3.0 | Copyright 2026 Cytostack Pvt Ltd",
    },
    search: {
      provider: "local",
    },
  },
  appearance: "dark",
  markdown: {
    lineNumbers: false,
  },
});
