// Circle = "Окружение" — группа контактов с ролями
export interface Circle {
  id: string;
  name: string; // "Семья", "Друзья", custom
  icon: string | null;
  color: string | null;
  ownerId: string;
  membersCount: number;
  createdAt: string;
}

export interface CircleMember {
  id: string;
  circleId: string;
  userId: string | null; // null if contact not on platform yet
  contactPhone: string;
  contactName: string;
  role: string; // "жена", "мама", "друг", custom
  avatar: string | null;
  isOnPlatform: boolean; // true if user exists with this phone
  createdAt: string;
}

export interface CreateCircleRequest {
  name: string;
  icon?: string;
  color?: string;
}

export interface AddCircleMemberRequest {
  contactPhone: string;
  contactName: string;
  role: string;
}

// Predefined role suggestions (user can create custom)
export const CIRCLE_ROLE_SUGGESTIONS = [
  'жена', 'муж', 'мама', 'папа', 'сын', 'дочь',
  'брат', 'сестра', 'бабушка', 'дедушка',
  'друг', 'подруга', 'коллега', 'сосед',
] as const;
