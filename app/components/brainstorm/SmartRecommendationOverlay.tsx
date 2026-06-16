interface SmartRecommendationOverlayProps {
  descriptionLength: number;
}

export default function SmartRecommendationOverlay({ descriptionLength }: SmartRecommendationOverlayProps) {
  const complexity = Math.min(1, descriptionLength / 500);
  const recommended = Math.max(3, Math.min(8, Math.round(3 + complexity * 5)));

  return (
    <div className="bg-blue-50 border border-blue-200 rounded p-3 text-sm">
      <span className="text-blue-800 font-medium">Complexity analysis: </span>
      <span className="text-blue-700">
        Based on description length, we recommend <strong>{recommended} passes</strong> for thorough exploration.
      </span>
    </div>
  );
}