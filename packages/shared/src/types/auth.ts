export interface LoginRequest {
  phone: string;
  password: string;
}

export interface RegisterRequest {
  phone: string;
  password: string;
  firstName: string;
  lastName?: string;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export interface VerifyOtpRequest {
  phone: string;
  code: string;
}

export interface RefreshTokenRequest {
  refreshToken: string;
}

export interface SessionInfo {
  id: string;
  deviceInfo: string | null;
  lastActiveAt: string;
  createdAt: string;
  isCurrent: boolean;
}
