export interface User {
  id: string;
  phone: string;
  firstName: string;
  lastName: string | null;
  avatar: string | null;
  isVerified: boolean;
  locale: string;
  timezone: string;
  createdAt: string;
  updatedAt: string;
}

export interface UserProfile extends User {
  circlesCount: number;
  workspacesCount: number;
  activeSubscription: SubscriptionInfo | null;
}

export interface SubscriptionInfo {
  id: string;
  plan: 'free' | 'personal' | 'family' | 'business';
  status: 'active' | 'trial' | 'expired' | 'cancelled';
  expiresAt: string;
  giftedBy: string | null;
}
