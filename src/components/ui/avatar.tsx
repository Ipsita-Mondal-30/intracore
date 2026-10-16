import { cn } from "@/lib/utils";

export function Avatar({
  name,
  src,
  className,
  size = "md",
}: {
  name?: string | null;
  src?: string | null;
  className?: string;
  size?: "sm" | "md" | "lg";
}) {
  const initials =
    name
      ?.split(" ")
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase())
      .join("") || "?";

  const sizes = {
    sm: "h-8 w-8 text-2xs",
    md: "h-10 w-10 text-xs",
    lg: "h-14 w-14 text-sm",
  };

  if (src) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={src}
        alt={name ?? "Avatar"}
        className={cn(
          "rounded-full object-cover ring-2 ring-surface",
          sizes[size],
          className,
        )}
      />
    );
  }

  return (
    <div
      className={cn(
        "inline-flex items-center justify-center rounded-full bg-primary-soft font-semibold text-primary ring-2 ring-surface",
        sizes[size],
        className,
      )}
      aria-hidden
    >
      {initials}
    </div>
  );
}
