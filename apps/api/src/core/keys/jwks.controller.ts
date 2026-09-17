import { Controller, Get, Header } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { KEYS_LIMITS } from '@superapp/shared';
import { Public } from '../../shared/decorators/public.decorator';
import { KeysSigningService } from './keys.signing.service';

/**
 * JWKS платформы: открытые ключи всех аудиторий (активные и «на выводе»). Публикуется
 * дважды: по стандартному адресу `/.well-known/jwks.json` (вне префикса `/api`, см.
 * main.ts) и под `/api/v1/keys/jwks` для клиентов, которые ходят только через API.
 * Кэш 10 минут — ровно на него смещена активация новой версии.
 */
@ApiTags('Keys')
@Controller('.well-known')
export class JwksWellKnownController {
  constructor(private readonly signing: KeysSigningService) {}

  @Public()
  @Get('jwks.json')
  @Header('Cache-Control', `public, max-age=${KEYS_LIMITS.jwksCacheSec}`)
  @ApiOperation({ summary: 'JSON Web Key Set of the platform (Ed25519, all audiences)' })
  async jwks() {
    return this.signing.jwks();
  }
}

@ApiTags('Keys')
@Controller('keys')
export class JwksApiController {
  constructor(private readonly signing: KeysSigningService) {}

  @Public()
  @Get('jwks')
  @Header('Cache-Control', `public, max-age=${KEYS_LIMITS.jwksCacheSec}`)
  @ApiOperation({ summary: 'JSON Web Key Set of the platform (API alias)' })
  async jwks() {
    return this.signing.jwks();
  }
}
