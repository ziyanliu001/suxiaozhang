export interface DonorItem {
  name: string;
  amount: number;
}

export interface OfflineReportData {
  id: string;
  timestamp: number;
  dateString: string;
  reportDate: string;
  shopName: string;
  mpAccount: string;
  yesterdayBalance: number;
  otherDonation: number;
  listDonationTotal: number;
  expenseAmount: number;
  todayBalance: number;
  reportText: string;
  donationItems: DonorItem[];
  receiptImages: string[];
  isManualAdjust: boolean;
  systemBalance: number;
  adjustedBalance: number;
  balanceDiff: number;
  adjustReason: string;
  materials?: { donor: string; item: string; quantity: string; unit: string }[];
  volunteerCount?: number;
  volunteerHours?: number;
}

const STORAGE_KEY = 'PENDING_REPORTS';

export function getQueue(): OfflineReportData[] {
  try {
    const data = wx.getStorageSync(STORAGE_KEY);
    if (data && Array.isArray(data)) {
      return data;
    }
  } catch (error) {
    console.error('[offlineQueue] getQueue error:', error);
  }
  return [];
}

export function saveToQueue(reportData: Omit<OfflineReportData, 'id' | 'timestamp'>): OfflineReportData {
  const queue = getQueue();
  const newItem: OfflineReportData = {
    ...reportData,
    id: `${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    timestamp: Date.now()
  };
  queue.push(newItem);
  try {
    wx.setStorageSync(STORAGE_KEY, queue);
  } catch (error) {
    console.error('[offlineQueue] saveToQueue error:', error);
  }
  return newItem;
}

export function removeFromQueue(id: string): void {
  const queue = getQueue();
  const newQueue = queue.filter(item => item.id !== id);
  try {
    wx.setStorageSync(STORAGE_KEY, newQueue);
  } catch (error) {
    console.error('[offlineQueue] removeFromQueue error:', error);
  }
}

export function clearQueue(): void {
  try {
    wx.setStorageSync(STORAGE_KEY, []);
  } catch (error) {
    console.error('[offlineQueue] clearQueue error:', error);
  }
}

export function getQueueCount(): number {
  return getQueue().length;
}
