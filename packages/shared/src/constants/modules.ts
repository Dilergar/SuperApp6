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
  // Future modules — uncomment when ready
  // finance: { id: 'finance', name: 'Финансы', ... },
  // coins: { id: 'coins', name: 'Коины', ... },
  // shop: { id: 'shop', name: 'Магазин', ... },
  // chat: { id: 'chat', name: 'Чат', ... },
  // jobs: { id: 'jobs', name: 'Работа', ... },
};

export const MODULE_IDS = Object.keys(MODULES);
