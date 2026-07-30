// Legacy import compatibility. The product route is now `/m/chat`; keeping
// this named export prevents downstream previews/tests from breaking while
// `/m/now` redirects to the canonical Chat surface.
export { MobileWorkPage as MobileNowPage } from "./work.js";
