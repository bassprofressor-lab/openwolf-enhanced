<script setup lang="ts">
import { ref, onMounted, onUnmounted } from "vue";

const copied = ref(false);
const mounted = ref(false);

function copyInstall() {
  navigator.clipboard.writeText("npm install -g openwolf");
  copied.value = true;
  setTimeout(() => (copied.value = false), 2000);
}

// Scroll-driven reveal
let observer: IntersectionObserver | null = null;

onMounted(() => {
  mounted.value = true;
  observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add("revealed");
          observer?.unobserve(entry.target);
        }
      });
    },
    { threshold: 0.08, rootMargin: "0px 0px -40px 0px" }
  );
  document
    .querySelectorAll(".reveal")
    .forEach((el) => observer?.observe(el));
});

onUnmounted(() => observer?.disconnect());
</script>

<template>
  <div data-theme="dark" class="ow-landing font-[Inter,system-ui,sans-serif] text-base-content">

    <!-- ============================================================ -->
    <!-- HERO                                                         -->
    <!-- ============================================================ -->
    <section class="relative min-h-[100dvh] flex items-center justify-center overflow-hidden bg-base-100">

      <!-- Background grid + glow -->
      <div class="pointer-events-none absolute inset-0">
        <!-- Dot grid -->
        <div class="absolute inset-0 opacity-[0.035]"
             style="background-image:radial-gradient(circle,currentColor 1px,transparent 1px);background-size:32px 32px">
        </div>
        <!-- Radial gradient mask -->
        <div class="absolute inset-0"
             style="background:radial-gradient(ellipse 70% 50% at 50% 40%,transparent 0%,var(--fallback-b1,oklch(var(--b1))) 100%)">
        </div>
        <!-- Brand glow -->
        <div class="absolute top-[-20%] left-1/2 -translate-x-1/2 w-[600px] h-[600px] rounded-full bg-primary/10 blur-[120px] animate-pulse"></div>
        <div class="absolute top-[10%] right-[-5%] w-[350px] h-[350px] rounded-full bg-secondary/8 blur-[100px] animate-pulse [animation-delay:2s]"></div>
      </div>

      <div class="relative z-10 w-full max-w-5xl mx-auto px-5 sm:px-8 py-28 sm:py-32 lg:py-40">
        <div class="flex flex-col lg:flex-row lg:items-center lg:gap-16">

          <!-- Left: Copy -->
          <div class="flex-1 max-w-xl" :class="{ 'animate-[fadeUp_0.7s_ease_both]': mounted }">

            <!-- Version badge -->
            <div class="inline-flex items-center gap-2 rounded-full border border-base-content/10 bg-base-content/[0.03] px-3.5 py-1.5 text-xs font-medium tracking-wide text-base-content/60 mb-7">
              <span class="relative flex h-1.5 w-1.5">
                <span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-success opacity-75"></span>
                <span class="relative inline-flex rounded-full h-1.5 w-1.5 bg-success"></span>
              </span>
              v1.0.0 &middot; Open Source
            </div>

            <h1 class="text-[clamp(2.25rem,5.5vw,3.75rem)] font-extrabold leading-[1.08] tracking-[-0.035em] text-base-content">
              Token-Conscious
              <br />
              <span class="bg-gradient-to-r from-primary via-secondary to-accent bg-clip-text text-transparent">
                AI Brain
              </span>
              <br />
              <span class="text-[0.44em] font-medium tracking-[-0.01em] text-base-content/50">
                for Claude Code
              </span>
            </h1>

            <p class="mt-6 text-base sm:text-lg leading-relaxed text-base-content/55 max-w-md">
              Invisible middleware that makes every Claude&nbsp;Code session smarter.
              Anatomy tracking, learning memory, design&nbsp;QC.
              <strong class="text-base-content/80 font-semibold">Zero extra AI cost.</strong>
            </p>

            <!-- Actions -->
            <div class="flex flex-wrap items-center gap-3 mt-9">
              <a href="/getting-started" class="btn btn-primary btn-md sm:btn-lg gap-2 shadow-lg shadow-primary/20 no-underline">
                <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
                Get Started
              </a>
              <a href="/how-it-works" class="btn btn-ghost btn-md sm:btn-lg gap-2 no-underline">
                How It Works
                <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
              </a>
            </div>

            <!-- Install command -->
            <button
              @click="copyInstall"
              class="group mt-8 inline-flex items-center gap-3 rounded-xl border border-base-content/8 bg-base-content/[0.03] px-5 py-3 font-mono text-sm transition-all hover:border-primary/30 hover:bg-primary/[0.04] cursor-pointer"
            >
              <span class="text-primary font-bold select-none">$</span>
              <code class="text-base-content/70 group-hover:text-base-content/90 transition-colors">npm install -g openwolf</code>
              <span class="text-base-content/30 group-hover:text-primary/60 transition-colors ml-1">
                <svg v-if="!copied" class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                <svg v-else class="w-4 h-4 text-success" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>
              </span>
            </button>
          </div>

          <!-- Right: Terminal mock -->
          <div class="flex-1 mt-12 lg:mt-0 max-w-lg w-full"
               :class="{ 'animate-[fadeUp_0.9s_0.15s_ease_both]': mounted }">
            <div class="rounded-2xl border border-base-content/8 bg-base-200/60 shadow-2xl shadow-black/30 overflow-hidden backdrop-blur-sm">
              <!-- Title bar -->
              <div class="flex items-center gap-2.5 px-4 py-3 border-b border-base-content/5">
                <span class="w-2.5 h-2.5 rounded-full bg-error/70"></span>
                <span class="w-2.5 h-2.5 rounded-full bg-warning/70"></span>
                <span class="w-2.5 h-2.5 rounded-full bg-success/70"></span>
                <span class="ml-2 text-[11px] font-mono text-base-content/30 tracking-wide">terminal</span>
              </div>
              <!-- Body -->
              <div class="px-5 py-5 font-mono text-[13px] leading-[1.9] space-y-0.5">
                <div><span class="text-primary font-bold">$</span> <span class="text-base-content/80">openwolf init</span></div>
                <div class="text-base-content/45"><span class="text-success">&check;</span> OpenWolf initialized</div>
                <div class="text-base-content/45"><span class="text-success">&check;</span> .wolf/ created with 11 files</div>
                <div class="text-base-content/45"><span class="text-success">&check;</span> Claude Code hooks registered (6 hooks)</div>
                <div class="text-base-content/45"><span class="text-success">&check;</span> CLAUDE.md updated</div>
                <div class="text-base-content/45"><span class="text-success">&check;</span> Anatomy scan: 47 files indexed</div>
                <div class="mt-3 text-base-content/30 text-xs">You're ready. Just use <span class="text-primary/60">'claude'</span> as normal — OpenWolf is watching.</div>
              </div>
            </div>
          </div>

        </div>
      </div>

      <!-- Scroll hint -->
      <div class="absolute bottom-8 left-1/2 -translate-x-1/2 animate-bounce opacity-30">
        <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M19 12l-7 7-7-7"/></svg>
      </div>
    </section>

    <!-- ============================================================ -->
    <!-- FEATURES                                                     -->
    <!-- ============================================================ -->
    <section class="bg-base-200/50 py-24 sm:py-32">
      <div class="max-w-6xl mx-auto px-5 sm:px-8">

        <div class="text-center mb-16 reveal">
          <div class="badge badge-outline badge-primary badge-sm font-semibold tracking-widest uppercase mb-5">Features</div>
          <h2 class="text-3xl sm:text-4xl font-extrabold tracking-tight">
            Everything works invisibly
          </h2>
          <p class="mt-4 text-base-content/50 max-w-lg mx-auto text-base sm:text-lg leading-relaxed">
            OpenWolf hooks into Claude Code's lifecycle. No commands to remember. It just makes every session smarter.
          </p>
        </div>

        <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">

          <!-- Card: Invisible Enforcement -->
          <div class="reveal card bg-base-100 border border-base-content/5 shadow-sm hover:shadow-lg hover:border-primary/20 transition-all duration-300 group">
            <div class="card-body p-7">
              <div class="w-11 h-11 rounded-xl bg-primary/10 flex items-center justify-center mb-4 group-hover:bg-primary/15 transition-colors">
                <svg class="w-5 h-5 text-primary" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a7 7 0 0 0-7 7c0 2.38 1.19 4.47 3 5.74V17a2 2 0 0 0 2 2h4a2 2 0 0 0 2-2v-2.26c1.81-1.27 3-3.36 3-5.74a7 7 0 0 0-7-7z"/><path d="M10 21h4M12 17v4"/></svg>
              </div>
              <h3 class="card-title text-base font-bold">Invisible Enforcement</h3>
              <p class="text-sm text-base-content/50 leading-relaxed">You type <code class="text-xs bg-base-content/5 px-1.5 py-0.5 rounded">claude</code> and work normally. Hooks fire automatically — tracking tokens, updating project maps, enforcing learned preferences.</p>
            </div>
          </div>

          <!-- Card: Token Intelligence -->
          <div class="reveal card bg-base-100 border border-base-content/5 shadow-sm hover:shadow-lg hover:border-secondary/20 transition-all duration-300 group" style="transition-delay:60ms">
            <div class="card-body p-7">
              <div class="w-11 h-11 rounded-xl bg-secondary/10 flex items-center justify-center mb-4 group-hover:bg-secondary/15 transition-colors">
                <svg class="w-5 h-5 text-secondary" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 20V10M12 20V4M6 20v-6"/></svg>
              </div>
              <h3 class="card-title text-base font-bold">Token Intelligence</h3>
              <p class="text-sm text-base-content/50 leading-relaxed">Every token is estimated, tracked, and justified. Anatomy descriptions prevent unnecessary file reads. Repeated reads are caught and flagged.</p>
            </div>
          </div>

          <!-- Card: Zero Cost -->
          <div class="reveal card bg-base-100 border border-base-content/5 shadow-sm hover:shadow-lg hover:border-success/20 transition-all duration-300 group" style="transition-delay:120ms">
            <div class="card-body p-7">
              <div class="w-11 h-11 rounded-xl bg-success/10 flex items-center justify-center mb-4 group-hover:bg-success/15 transition-colors">
                <svg class="w-5 h-5 text-success" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
              </div>
              <h3 class="card-title text-base font-bold">Zero Extra AI Cost</h3>
              <p class="text-sm text-base-content/50 leading-relaxed">All hooks are pure Node.js file I/O. No API calls during normal operation. Optional weekly AI tasks use your existing Claude subscription.</p>
            </div>
          </div>

          <!-- Card: Self-Learning -->
          <div class="reveal card bg-base-100 border border-base-content/5 shadow-sm hover:shadow-lg hover:border-warning/20 transition-all duration-300 group" style="transition-delay:180ms">
            <div class="card-body p-7">
              <div class="w-11 h-11 rounded-xl bg-warning/10 flex items-center justify-center mb-4 group-hover:bg-warning/15 transition-colors">
                <svg class="w-5 h-5 text-warning" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M17 1l4 4-4 4M3 11V9a4 4 0 0 1 4-4h14M7 23l-4-4 4-4M21 13v2a4 4 0 0 1-4 4H3"/></svg>
              </div>
              <h3 class="card-title text-base font-bold">Self-Learning</h3>
              <p class="text-sm text-base-content/50 leading-relaxed">Cerebrum tracks your preferences, mistakes, and decisions. Bug memory prevents the same fix twice. The system gets smarter every session.</p>
            </div>
          </div>

          <!-- Card: Design QC -->
          <div class="reveal card bg-base-100 border border-base-content/5 shadow-sm hover:shadow-lg hover:border-error/20 transition-all duration-300 group" style="transition-delay:240ms">
            <div class="card-body p-7">
              <div class="w-11 h-11 rounded-xl bg-error/10 flex items-center justify-center mb-4 group-hover:bg-error/15 transition-colors">
                <svg class="w-5 h-5 text-error" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
              </div>
              <h3 class="card-title text-base font-bold">Design QC</h3>
              <p class="text-sm text-base-content/50 leading-relaxed">Capture full-page sectioned screenshots with one command. Claude evaluates the design inline — no external services, no extra cost.</p>
            </div>
          </div>

          <!-- Card: Reframe -->
          <div class="reveal card bg-base-100 border border-base-content/5 shadow-sm hover:shadow-lg hover:border-info/20 transition-all duration-300 group" style="transition-delay:300ms">
            <div class="card-body p-7">
              <div class="w-11 h-11 rounded-xl bg-info/10 flex items-center justify-center mb-4 group-hover:bg-info/15 transition-colors">
                <svg class="w-5 h-5 text-info" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>
              </div>
              <h3 class="card-title text-base font-bold">Reframe</h3>
              <p class="text-sm text-base-content/50 leading-relaxed">Ask Claude to help pick a UI framework. Built-in knowledge base covers 12 component libraries — from shadcn/ui to Aceternity UI to DaisyUI.</p>
            </div>
          </div>

        </div>
      </div>
    </section>

    <!-- ============================================================ -->
    <!-- HOW IT WORKS                                                 -->
    <!-- ============================================================ -->
    <section class="py-24 sm:py-32 bg-base-100">
      <div class="max-w-4xl mx-auto px-5 sm:px-8">

        <div class="text-center mb-16 reveal">
          <div class="badge badge-outline badge-secondary badge-sm font-semibold tracking-widest uppercase mb-5">How It Works</div>
          <h2 class="text-3xl sm:text-4xl font-extrabold tracking-tight">Three steps. Then invisible.</h2>
        </div>

        <!-- Steps -->
        <div class="space-y-5">
          <div class="reveal flex flex-col sm:flex-row gap-5 sm:gap-7 items-start p-6 sm:p-8 rounded-2xl border border-base-content/5 bg-base-200/40 hover:border-primary/15 transition-colors">
            <div class="text-5xl font-black text-primary/15 leading-none tracking-tighter select-none shrink-0">01</div>
            <div class="flex-1 min-w-0">
              <h3 class="text-lg font-bold mb-1.5">Initialize</h3>
              <p class="text-sm text-base-content/50 leading-relaxed mb-4">Run one command in any project. Creates <code class="text-xs bg-base-content/5 px-1.5 py-0.5 rounded">.wolf/</code> directory, registers hooks, scans all files.</p>
              <div class="font-mono text-sm bg-base-300/50 rounded-xl px-4 py-2.5 inline-flex items-center gap-2.5">
                <span class="text-primary font-bold">$</span>
                <span class="text-base-content/70">openwolf init</span>
              </div>
            </div>
          </div>

          <div class="reveal flex flex-col sm:flex-row gap-5 sm:gap-7 items-start p-6 sm:p-8 rounded-2xl border border-base-content/5 bg-base-200/40 hover:border-secondary/15 transition-colors" style="transition-delay:100ms">
            <div class="text-5xl font-black text-secondary/15 leading-none tracking-tighter select-none shrink-0">02</div>
            <div class="flex-1 min-w-0">
              <h3 class="text-lg font-bold mb-1.5">Work Normally</h3>
              <p class="text-sm text-base-content/50 leading-relaxed mb-4">Just use <code class="text-xs bg-base-content/5 px-1.5 py-0.5 rounded">claude</code> as you always do. Hooks fire invisibly — tracking, learning, enforcing. You don't interact with any of it.</p>
              <div class="font-mono text-sm bg-base-300/50 rounded-xl px-4 py-2.5 inline-flex items-center gap-2.5">
                <span class="text-primary font-bold">$</span>
                <span class="text-base-content/70">claude</span>
              </div>
            </div>
          </div>

          <div class="reveal flex flex-col sm:flex-row gap-5 sm:gap-7 items-start p-6 sm:p-8 rounded-2xl border border-base-content/5 bg-base-200/40 hover:border-accent/15 transition-colors" style="transition-delay:200ms">
            <div class="text-5xl font-black text-accent/15 leading-none tracking-tighter select-none shrink-0">03</div>
            <div class="flex-1 min-w-0">
              <h3 class="text-lg font-bold mb-1.5">Get Smarter</h3>
              <p class="text-sm text-base-content/50 leading-relaxed mb-4">Every session, OpenWolf learns preferences, logs bugs, prevents repeated mistakes. View everything on the real-time dashboard.</p>
              <div class="font-mono text-sm bg-base-300/50 rounded-xl px-4 py-2.5 inline-flex items-center gap-2.5">
                <span class="text-primary font-bold">$</span>
                <span class="text-base-content/70">openwolf dashboard</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- ============================================================ -->
    <!-- ARCHITECTURE                                                 -->
    <!-- ============================================================ -->
    <section class="py-24 sm:py-32 bg-base-200/50">
      <div class="max-w-6xl mx-auto px-5 sm:px-8">

        <div class="text-center mb-16 reveal">
          <div class="badge badge-outline badge-accent badge-sm font-semibold tracking-widest uppercase mb-5">Architecture</div>
          <h2 class="text-3xl sm:text-4xl font-extrabold tracking-tight">
            The <code class="font-mono text-primary">.wolf/</code> directory
          </h2>
          <p class="mt-4 text-base-content/50 max-w-lg mx-auto text-base leading-relaxed">
            Every project gets a <code class="text-xs bg-base-content/5 px-1.5 py-0.5 rounded">.wolf/</code> folder containing state, learning memory, and configuration. Markdown is the source of truth.
          </p>
        </div>

        <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          <div class="reveal rounded-xl border border-base-content/5 bg-base-100 p-6 hover:border-secondary/15 transition-colors">
            <div class="w-9 h-9 rounded-lg bg-secondary/10 flex items-center justify-center mb-3.5">
              <svg class="w-[18px] h-[18px] text-secondary" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M16 13H8M16 17H8M10 9H8"/></svg>
            </div>
            <h4 class="font-mono text-sm font-bold mb-1.5">anatomy.md</h4>
            <p class="text-xs text-base-content/45 leading-relaxed">File index with descriptions and token estimates. Prevents unnecessary full-file reads.</p>
          </div>

          <div class="reveal rounded-xl border border-base-content/5 bg-base-100 p-6 hover:border-primary/15 transition-colors" style="transition-delay:50ms">
            <div class="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center mb-3.5">
              <svg class="w-[18px] h-[18px] text-primary" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a7 7 0 0 0-7 7c0 2.38 1.19 4.47 3 5.74V17a2 2 0 0 0 2 2h4a2 2 0 0 0 2-2v-2.26c1.81-1.27 3-3.36 3-5.74a7 7 0 0 0-7-7z"/></svg>
            </div>
            <h4 class="font-mono text-sm font-bold mb-1.5">cerebrum.md</h4>
            <p class="text-xs text-base-content/45 leading-relaxed">Learned preferences, conventions, Do-Not-Repeat mistakes. Gets smarter every session.</p>
          </div>

          <div class="reveal rounded-xl border border-base-content/5 bg-base-100 p-6 hover:border-success/15 transition-colors" style="transition-delay:100ms">
            <div class="w-9 h-9 rounded-lg bg-success/10 flex items-center justify-center mb-3.5">
              <svg class="w-[18px] h-[18px] text-success" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>
            </div>
            <h4 class="font-mono text-sm font-bold mb-1.5">memory.md</h4>
            <p class="text-xs text-base-content/45 leading-relaxed">Chronological action log. Every read, write, and decision recorded per session.</p>
          </div>

          <div class="reveal rounded-xl border border-base-content/5 bg-base-100 p-6 hover:border-warning/15 transition-colors" style="transition-delay:150ms">
            <div class="w-9 h-9 rounded-lg bg-warning/10 flex items-center justify-center mb-3.5">
              <svg class="w-[18px] h-[18px] text-warning" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><path d="M12 9v4M12 17h.01"/></svg>
            </div>
            <h4 class="font-mono text-sm font-bold mb-1.5">buglog.json</h4>
            <p class="text-xs text-base-content/45 leading-relaxed">Bug encounter and resolution memory. Searchable. Prevents re-discovering the same fix.</p>
          </div>

          <div class="reveal rounded-xl border border-base-content/5 bg-base-100 p-6 hover:border-error/15 transition-colors" style="transition-delay:200ms">
            <div class="w-9 h-9 rounded-lg bg-error/10 flex items-center justify-center mb-3.5">
              <svg class="w-[18px] h-[18px] text-error" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><path d="M8 21h8M12 17v4"/></svg>
            </div>
            <h4 class="font-mono text-sm font-bold mb-1.5">hooks/</h4>
            <p class="text-xs text-base-content/45 leading-relaxed">6 Node.js hooks that fire on every Claude action. Pure file I/O, no network, no AI calls.</p>
          </div>

          <div class="reveal rounded-xl border border-base-content/5 bg-base-100 p-6 hover:border-info/15 transition-colors" style="transition-delay:250ms">
            <div class="w-9 h-9 rounded-lg bg-info/10 flex items-center justify-center mb-3.5">
              <svg class="w-[18px] h-[18px] text-info" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/></svg>
            </div>
            <h4 class="font-mono text-sm font-bold mb-1.5">config.json</h4>
            <p class="text-xs text-base-content/45 leading-relaxed">All settings with sensible defaults. Token ratios, cron schedules, dashboard port, exclude patterns.</p>
          </div>
        </div>
      </div>
    </section>

    <!-- ============================================================ -->
    <!-- HOOKS PIPELINE                                               -->
    <!-- ============================================================ -->
    <section class="py-24 sm:py-32 bg-base-100">
      <div class="max-w-4xl mx-auto px-5 sm:px-8">

        <div class="text-center mb-16 reveal">
          <div class="badge badge-outline badge-warning badge-sm font-semibold tracking-widest uppercase mb-5">Hooks</div>
          <h2 class="text-3xl sm:text-4xl font-extrabold tracking-tight">The enforcement layer</h2>
          <p class="mt-4 text-base-content/50 max-w-md mx-auto text-base leading-relaxed">
            Six hooks fire on every Claude action. They warn but never block. Pure Node.js — no network, no AI, no extra cost.
          </p>
        </div>

        <div class="space-y-3 reveal">
          <div v-for="(hook, i) in [
            { event: 'SessionStart', script: 'session-start.js', desc: 'Creates session tracker, logs to memory' },
            { event: 'PreToolUse', script: 'pre-read.js', desc: 'Warns on repeated reads, shows anatomy info' },
            { event: 'PreToolUse', script: 'pre-write.js', desc: 'Checks cerebrum Do-Not-Repeat patterns' },
            { event: 'PostToolUse', script: 'post-read.js', desc: 'Estimates and records token usage' },
            { event: 'PostToolUse', script: 'post-write.js', desc: 'Updates anatomy, appends to memory' },
            { event: 'Stop', script: 'stop.js', desc: 'Writes session summary to token ledger' },
          ]" :key="i"
             class="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4 p-4 rounded-xl border border-base-content/5 bg-base-200/40 hover:border-primary/10 transition-colors"
          >
            <div class="shrink-0">
              <span class="badge badge-sm badge-primary badge-outline font-mono text-[11px] tracking-wide">{{ hook.event }}</span>
            </div>
            <div class="hidden sm:block text-base-content/20">&rarr;</div>
            <div class="font-mono text-sm text-base-content/70 shrink-0 min-w-[140px]">{{ hook.script }}</div>
            <div class="text-sm text-base-content/40">{{ hook.desc }}</div>
          </div>
        </div>
      </div>
    </section>

    <!-- ============================================================ -->
    <!-- CTA                                                          -->
    <!-- ============================================================ -->
    <section class="py-24 sm:py-32 bg-base-200/50">
      <div class="max-w-2xl mx-auto px-5 sm:px-8 text-center reveal">

        <h2 class="text-3xl sm:text-4xl font-extrabold tracking-tight mb-4">
          Start saving tokens today
        </h2>
        <p class="text-base-content/50 text-base sm:text-lg mb-10 leading-relaxed">
          One command to install. One command to initialize. Then it's invisible.
        </p>

        <div class="flex flex-wrap items-center justify-center gap-3 mb-12">
          <a href="/getting-started" class="btn btn-primary btn-lg gap-2 shadow-lg shadow-primary/20 no-underline">
            <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
            Get Started
          </a>
          <a href="https://github.com/cytostack/openwolf" target="_blank" class="btn btn-ghost btn-lg gap-2 no-underline">
            <svg class="w-4 h-4" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/></svg>
            GitHub
          </a>
        </div>

        <p class="text-xs text-base-content/25">AGPL-3.0 &middot; Copyright 2026 Cytostack Pvt Ltd</p>
      </div>
    </section>

  </div>
</template>

<style>
/* Keyframes for hero entrance */
@keyframes fadeUp {
  from { opacity: 0; transform: translateY(24px); }
  to   { opacity: 1; transform: translateY(0); }
}

/* Scroll reveal base */
.reveal {
  opacity: 0;
  transform: translateY(20px);
  transition: opacity 0.5s ease, transform 0.55s cubic-bezier(0.25, 1, 0.5, 1);
}
.reveal.revealed {
  opacity: 1;
  transform: translateY(0);
}

/* Prevent VitePress styles leaking into landing */
.ow-landing a { color: inherit; }
.ow-landing h1, .ow-landing h2, .ow-landing h3, .ow-landing h4 {
  border: none;
  margin: 0;
  padding: 0;
  letter-spacing: -0.02em;
}
.ow-landing code {
  background: none;
  color: inherit;
  font-size: inherit;
}
.ow-landing .card-title { margin: 0 0 6px; }
</style>
