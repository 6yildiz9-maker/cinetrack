import React from "react";
import { motion } from "framer-motion";

interface GlassCardProps {
  children: React.ReactNode;
  className?: string;
  onClick?: () => void;
  glow?: "gold" | "cyan" | "none";
  ariaLabel?: string;
}

export const GlassCard: React.FC<GlassCardProps> = ({
  children,
  className = "",
  onClick,
  glow = "none",
  ariaLabel,
}) => {
  const glowStyles = {
    gold: "hover:shadow-glowGold hover:border-cinema-gold/40",
    cyan: "hover:shadow-glowCyan hover:border-cinema-cyan/40",
    none: "hover:border-white/15",
  };

  if (onClick) {
    return (
      <motion.div
        role="button"
        tabIndex={0}
        aria-label={ariaLabel}
        whileHover={{ scale: 1.015, y: -2 }}
        whileTap={{ scale: 0.985 }}
        onClick={onClick}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onClick();
          }
        }}
        className={`glass-card p-5 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cinema-gold/60 ${glowStyles[glow]} ${className}`}
      >
        {children}
      </motion.div>
    );
  }

  return (
    <motion.div className={`glass-card p-5 ${glowStyles[glow]} ${className}`}>
      {children}
    </motion.div>
  );
};
