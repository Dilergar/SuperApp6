import type { ModuleDefinition } from '../types/common';

/**
 * Module registry — all available modules in the SuperApp.
 * Each service is a module that can be enabled/disabled per user or workspace.
 * New modules are added here as they are developed.
 */
export const MODULES: Record<string, ModuleDefinition> = {
  circles: {
    id: 'circles',
    name: 'Окружение',
    description: 'Управление контактами и ролями',
    icon: 'users',
    version: '1.0.0',
    category: 'core',
    requiredPermissions: [],
    routes: [
      { path: '/circles', label: 'Окружение' },
    ],
  },
  tasks: {
    id: 'tasks',
    name: 'Задачи',
    description: 'Менеджер задач с подзадачами и назначением',
    icon: 'check-square',
    version: '1.0.0',
    category: 'life',
    requiredPermissions: [],
    routes: [
      { path: '/tasks', label: 'Задачи' },
    ],
  },
  calendar: {
    id: 'calendar',
    name: 'Календарь',
    description: 'Календарь с интеграцией Google Calendar',
    icon: 'calendar',
    version: '1.0.0',
    category: 'life',
    requiredPermissions: [],
    routes: [
      { path: '/calendar', label: 'Календарь' },
    ],
  },
  shop: {
    id: 'shop',
    name: 'My Wish & Shop',
    description: 'Витрины подарков за коины и списки желаний',
    icon: 'shopping-bag',
    version: '1.0.0',
    category: 'life',
    requiredPermissions: [],
    routes: [
      { path: '/shop', label: 'My Wish & Shop' },
    ],
  },
  finance: {
    id: 'finance',
    name: 'Финансы',
    description: 'Личный и семейный учёт: счета, категории, лимиты, долги',
    icon: 'wallet',
    version: '1.0.0',
    category: 'life',
    requiredPermissions: [],
    routes: [
      { path: '/finance', label: 'Финансы' },
    ],
  },
  // Future modules — uncomment when ready
  // coins: { id: 'coins', name: 'Коины', ... },
  // chat: { id: 'chat', name: 'Чат', ... },
  // jobs: { id: 'jobs', name: 'Работа', ... },
};

export const MODULE_IDS = Object.keys(MODULES);
