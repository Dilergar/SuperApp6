import { Injectable, CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY, RequiredRole } from '../decorators/roles.decorator';
import { RolesService } from '../../core/roles/roles.service';
import type { JwtPayload } from '../decorators/current-user.decorator';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(
    private reflector: Reflector,
    private rolesService: RolesService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const requiredRoles = this.reflector.getAllAndOverride<RequiredRole[]>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );

    // No @Roles() decorator — allow access
    if (!requiredRoles || requiredRoles.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const user = request.user as JwtPayload;

    if (!user) return false;

    // System admins always pass
    if (user.role === 'admin') return true;

    // Check if user has ANY of the required roles
    for (const required of requiredRoles) {
      const tenantId = required.tenantParam
        ? request.params[required.tenantParam]
        : null;

      const hasRole = await this.rolesService.hasRole(
        user.sub,
        required.role,
        required.context,
        tenantId,
      );

      if (hasRole) return true;
    }

    return false;
  }
}
