# Reframe

Curated knowledge base of 12 modern UI frameworks with battle-tested prompts for Claude. Reframe is not a CLI command -- it is a reference file that Claude reads and uses to guide framework selection and migration.

## Overview

When you ask Claude to change, pick, or migrate your UI framework, Claude reads `.wolf/reframe-frameworks.md` (installed during `openwolf init`). The file contains decision criteria, framework profiles, and framework-specific prompts that Claude adapts to your project using `anatomy.md`.

No CLI invocation needed. Just talk to Claude about your UI framework and Reframe activates automatically.

---

## How It Works

1. `.wolf/reframe-frameworks.md` is created during `openwolf init`
2. When you mention changing or picking a UI framework, Claude reads the file
3. Claude asks **5 decision questions** to understand your priorities and constraints
4. Claude recommends a framework based on your answers
5. Claude uses the framework-specific prompt -- adapted to your project via `anatomy.md` -- to execute the installation and migration

The framework-specific prompts handle dependency installation, configuration, component patterns, and common migration steps. Claude tailors them to your actual project structure.

---

## Supported Frameworks

Reframe includes profiles and prompts for 12 frameworks:

| Framework | Description |
|-----------|-------------|
| **shadcn/ui** | React + Tailwind + Radix. Gold standard for full applications. |
| **Aceternity UI** | Framer Motion animations. Cinematic landing pages and scroll effects. |
| **Magic UI** | Polished SaaS aesthetic. Linear/Vercel-inspired design language. |
| **DaisyUI** | Tailwind plugin. Fastest setup, works with any JavaScript framework. |
| **HeroUI** | React Aria foundation. Polished components with strong accessibility. |
| **Chakra UI** | CSS-in-JS. Robust theming system, excellent developer experience. |
| **Flowbite** | Tailwind plugin. Business and enterprise look out of the box. |
| **Preline UI** | Tailwind plugin. Speed-focused with pre-built page sections. |
| **Park UI** | Ark UI headless + Tailwind. Works across React, Vue, and Solid. |
| **Origin UI** | 400+ free shadcn-based components. Drop-in library for shadcn projects. |
| **Headless UI** | Zero styling, full design control. Unstyled accessible primitives. |
| **Cult UI** | AI-forward aesthetic. Full-stack patterns for modern AI applications. |

---

## Quick Selection Guide

Use this priority table to narrow the choice before reading full profiles:

| Priority | Best Fit |
|----------|----------|
| Full app with many forms, tables, layouts | shadcn/ui |
| Cinematic animations and landing pages | Aceternity UI |
| SaaS marketing site, polished and minimal | Magic UI |
| Fastest possible setup, any framework | DaisyUI |
| Accessibility is non-negotiable | HeroUI |
| Deep theming and design tokens | Chakra UI |
| Enterprise/business dashboard | Flowbite |
| Speed to production with pre-built sections | Preline UI |
| Multi-framework project (React + Vue) | Park UI |
| Already using shadcn, need more components | Origin UI |
| Full design control, no opinions | Headless UI |
| AI-native product aesthetic | Cult UI |

---

## Example Conversation

```
You: I want to switch my UI framework
Claude: [reads reframe-frameworks.md]
        What framework does your project currently use?
You: React with plain Tailwind, no component library
Claude: What's your priority -- animations, speed, control, or accessibility?
You: Stunning animations for a landing page
Claude: I'd recommend Aceternity UI or Magic UI.
        Aceternity gives cinematic scroll effects with Framer Motion.
        Magic UI gives a polished SaaS look inspired by Linear and Vercel.
        Which direction fits better?
You: Let's go with Aceternity
Claude: [uses Aceternity prompt adapted to your project]
        [installs dependencies]
        [refactors components with animation patterns]
```

Claude handles the entire migration: installing packages, updating configs, converting components, and verifying the build still passes.

---

## Works with Design QC

Reframe pairs naturally with [Design QC](/designqc) in a full visual feedback loop:

1. **Evaluate** -- run `openwolf designqc` and ask Claude to review the current design
2. **Decide** -- discuss framework options with Claude (Reframe activates)
3. **Migrate** -- Claude installs the chosen framework and rebuilds components
4. **Verify** -- run `openwolf designqc` again and ask Claude to compare before/after

This loop keeps design decisions grounded in actual visual output rather than guesswork.
