import DefaultTheme from "vitepress/theme";
import type { Theme } from "vitepress";
import HeroLanding from "./components/HeroLanding.vue";
import "./tailwind.css";
import "./custom.css";

export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component("HeroLanding", HeroLanding);
  },
} satisfies Theme;
