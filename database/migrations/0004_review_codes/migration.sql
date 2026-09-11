-- Machine-readable review codes alongside the human-readable reasons.
-- Additive: existing rows default to an empty array.
ALTER TABLE "Candidate" ADD COLUMN "reviewCodes" TEXT[] DEFAULT ARRAY[]::TEXT[];
