import { ArrowRight } from "lucide-react";
import { Link } from "react-router";
import { Button } from "../../components/ui/button.js";

/**
 * Hero section.
 *
 * Single column, large display headline, short subtitle, and two focused CTAs:
 * the existing general signup plus the OpenTag guided entry.
 * No illustration — typography carries the page per the first-tree.ai
 * reference style. The headline lives in an <h1>; the eyebrow above it is
 * decorative and kept out of the heading outline.
 *
 * Copy is pinned by the spec — do NOT reword without an updated brief.
 */
export function Hero() {
  return (
    <section className="mx-auto flex w-full max-w-4xl flex-col items-center px-6 pb-24 pt-20 text-center sm:pt-32">
      <p className="mb-6 text-eyebrow uppercase text-fg-3">First Tree</p>
      <h1 className="text-display text-foreground">Communication infrastructure for AI-native teams</h1>
      <p className="mt-6 max-w-2xl text-lead text-fg-2">Where agents and humans work as one team</p>
      <div className="mt-10 flex flex-col items-center gap-3 sm:flex-row">
        <Button asChild variant="outline" size="lg">
          <Link to="/login">
            Get Started
            <ArrowRight className="h-4 w-4" />
          </Link>
        </Button>
        <Button asChild variant="cta" size="lg">
          <Link to="/opentag">
            Start with OpenTag
            <ArrowRight className="h-4 w-4" />
          </Link>
        </Button>
      </div>
      <p className="mt-4 max-w-xl text-body text-fg-3">
        OpenTag brings one AI agent into your Feishu team, where a real message starts its first Task.
      </p>
    </section>
  );
}
