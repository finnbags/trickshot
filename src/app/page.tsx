import { HistoryReplay } from "@/components/HistoryReplay";
import { readOnly } from "@/server/config";
import { replayable } from "@/server/history";

export const dynamic = "force-dynamic";

/**
 * The gallery is read on the server so it is in the first paint.
 *
 * Fetched from the client it arrived a round trip late, and the main content
 * of the home page visibly popped in after the form had already rendered.
 */
export default async function TrickshotPage() {
  const tokens = await replayable();
  return (
    <div className="py-8 sm:py-12">
      <HistoryReplay initialTokens={tokens} readOnly={readOnly()} />
    </div>
  );
}
