/**
 * How many times this CV has been parsed, beside the candidate's name.
 *
 * A CV parsed more than once is emphasised: a second parse means someone
 * reprocessed it or its Drive file changed, which is worth noticing when reading
 * the extracted fields. Zero shows as "Not parsed yet" rather than a bare "0×",
 * which would read like a fault.
 */
export function ParseCount({ count }: { count: number }) {
  const label = count === 0 ? "Not parsed yet" : `Parsed ${count}×`;
  const title = count === 0 ? "No parse has finished for this CV yet" : `Parsed ${count} ${count === 1 ? "time" : "times"} — the first parse plus any reprocessing`;
  return (
    <span
      title={title}
      aria-label={title}
      className={
        count > 1
          ? "numeric inline-flex flex-shrink-0 items-center rounded-md bg-brand-50 px-1.5 py-px text-[11px] font-semibold text-brand-700 ring-1 ring-inset ring-brand-600/20"
          : "numeric inline-flex flex-shrink-0 items-center rounded-md bg-ink-100 px-1.5 py-px text-[11px] font-medium text-ink-600"
      }
    >
      {label}
    </span>
  );
}
