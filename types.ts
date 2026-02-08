
export interface HealthStats {
  postureScore: number; // 0-100
  blinkRate: number;    // Blinks per minute
  fatigueLevel: string; // "Low", "Medium", "High"
  proximityScore: number; // 0-100 (how well they maintain safe distance)
  postureStatus: "Good" | "Fair" | "Poor";
  recommendation: string;
  baselineSet: boolean;
}

export interface LiveAPIConfig {
  apiKey: string;
}
