-- 0490_openwa_channel — provider OpenWA (fatia mínima AVIA).
--
-- Canal novo sem tocar no seam: UMA coluna nullable + as duas CHECKs de
-- provider reeditadas no mesmo bloco (padrão das migrations 0387 e afins —
-- UM bloco só por constraint, sem duplicar drop+add).
--
-- Idempotente e auto-curativo: `add column if not exists`, drop+add de
-- constraint (sem `if not exists` em ADD, porque o drop anterior garante).
-- Reaplica sem tocar em linha nenhuma; instalações antigas ganham a coluna
-- vazia e nenhum comportamento muda (nenhum leitor novo existe sem o código).
-- O apêndice idêntico entra no `baseline.sql` ANTES do bloco da VARREDURA
-- anon (que proíbe `create function`/`grant to anon` depois dela — aqui não
-- há função nem grant, mas a regra de posição vale para todo apêndice).

alter table public.channel_sessions
  add column if not exists openwa_session_id text;

alter table public.channel_sessions
  drop constraint if exists channel_sessions_provider_check;

alter table public.channel_sessions
  add constraint channel_sessions_provider_check
  check (provider = any (array['waha'::text, 'meta_cloud'::text, 'zernio'::text, 'wacalls'::text, 'zernio_social'::text, 'datafy'::text, 'openwa'::text]));

alter table public.channel_sessions
  drop constraint if exists channel_sessions_provider_ref_check;

alter table public.channel_sessions
  add constraint channel_sessions_provider_ref_check check (
    (provider = 'waha'       and waha_session_name    is not null) or
    (provider = 'meta_cloud' and meta_phone_number_id is not null) or
    (provider in ('zernio', 'zernio_social') and zernio_account_id is not null) or
    (provider = 'wacalls'    and wacalls_session_id    is not null) or
    (provider = 'datafy'     and datafy_phone_number_id is not null) or
    (provider = 'openwa'     and openwa_session_id     is not null)
  );

notify pgrst, 'reload schema';
