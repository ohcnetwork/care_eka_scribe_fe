import { Mic } from "lucide-react";

import { cn } from "@/lib/utils";

import { Button } from "@/components/ui/button";

interface ScribeButtonProps {
  onClick: () => void;
  className?: string;
}

export function ScribeButton({ onClick, className }: ScribeButtonProps) {
  return (
    <Button
      onClick={onClick}
      variant="primary_gradient"
      size="lg"
      className={cn(
        "fixed right-6 bottom-6 z-50 h-14 w-14 rounded-full p-0 shadow-lg transition-transform hover:scale-105",
        className,
      )}
      title="Start AI Scribe"
    >
      <Mic className="h-6 w-6" />
    </Button>
  );
}
