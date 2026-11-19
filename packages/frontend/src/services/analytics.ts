/**
 * Analytics domain client — view counts for the authenticated user's public
 * desktop.
 */

import { apiRequest } from './transport';

// ============ Analytics API ============

export interface AnalyticsData {
  totalViews: number;
  dailyViews: { date: string; count: number }[];
}

export async function fetchAnalytics(): Promise<AnalyticsData> {
  return apiRequest<AnalyticsData>('/api/analytics');
}
