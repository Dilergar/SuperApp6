// Pagination
export interface PaginatedRequest {
  page?: number;
  limit?: number;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
}

export interface PaginatedResponse<T> {
  data: T[];
  meta: {
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  };
}

// API Response wrapper
export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    details?: Record<string, string[]>;
  };
}

// Module system
export interface ModuleDefinition {
  id: string;
  name: string;
  description: string;
  icon: string;
  version: string;
  category: 'core' | 'life' | 'job' | 'marketplace';
  requiredPermissions: string[];
  routes: {
    path: string;
    label: string;
  }[];
}
