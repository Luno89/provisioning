/**
 * Palworld dedicated-server settings schema.
 *
 * Source of truth for the env-var → PalWorldSettings.ini mapping is the container image's own
 * `scripts/compile-settings.sh` (thijsvanloef/palworld-server-docker). Everything here mirrors a
 * name that script reads; adding a setting is a single entry in this file, which then flows to
 * the pod env, the Config-tab UI (GET /api/app-schemas/palworld) and the validator automatically.
 *
 * Defaults match the game's own defaults unless noted.
 */
import type { AppSetting, AppSettingsSchema } from './app-settings-schema.js';

export const PALWORLD_CATEGORIES = [
  'Server',
  'Operational',
  'Gameplay',
  'Rates',
  'Combat',
  'Pals',
  'Building',
  'Guild',
  'PvP',
  'Backup',
  'Advanced',
] as const;

/** Ports and ids the construct owns — see `readonly` in app-settings-schema.ts for why. */
export const PALWORLD_GAME_PORT = 8211;
export const PALWORLD_QUERY_PORT = 27015;
export const PALWORLD_REST_PORT = 8212;
export const PALWORLD_RCON_PORT = 25575;

/** Env vars sourced from the Kubernetes Secret, never from appSettings. */
export const PALWORLD_SECRET_ENVS = ['ADMIN_PASSWORD', 'SERVER_PASSWORD', 'RCON_PASSWORD'] as const;

const b = (
  env: string, key: string, label: string, def: string, category: string, help?: string,
): AppSetting => ({ env, key, label, default: def, category, type: 'bool', ...(help ? { help } : {}) });

const f = (
  env: string, key: string, label: string, def: string, category: string,
  min?: number, max?: number, help?: string,
): AppSetting => ({
  env, key, label, default: def, category, type: 'float', step: 0.1,
  ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}),
  ...(help ? { help } : {}),
});

const i = (
  env: string, key: string, label: string, def: string, category: string,
  min?: number, max?: number, help?: string,
): AppSetting => ({
  env, key, label, default: def, category, type: 'int',
  ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}),
  ...(help ? { help } : {}),
});

const s = (
  env: string, key: string, label: string, def: string, category: string, help?: string,
): AppSetting => ({ env, key, label, default: def, category, type: 'string', ...(help ? { help } : {}) });

const e = (
  env: string, key: string, label: string, def: string, category: string,
  options: readonly string[], help?: string,
): AppSetting => ({
  env, key, label, default: def, category, type: 'enum', options,
  ...(help ? { help } : {}),
});

const SETTINGS: AppSetting[] = [
  // ── Server identity ──────────────────────────────────────────────────────
  s('SERVER_NAME', 'ServerName', 'Server Name', 'A Palworld Server', 'Server'),
  s('SERVER_DESCRIPTION', 'ServerDescription', 'Server Description', '', 'Server'),
  i('PLAYERS', 'ServerPlayerMaxNum', 'Max Players', '16', 'Server', 1, 32),
  s('REGION', 'Region', 'Region', '', 'Server', 'Two-letter region code shown in the server browser.'),
  b('COMMUNITY', 'bIsCommunityServer', 'List in Community Browser', 'false', 'Server',
    'Requires a server password to be unset. The community browser is unreliable; direct connect by IP always works.'),
  b('USEAUTH', 'bUseAuth', 'Require Authentication', 'true', 'Server'),
  s('BAN_LIST_URL', 'BanListURL', 'Ban List URL', 'https://api.palworldgame.com/api/banlist.txt', 'Server'),
  e('LOG_FORMAT_TYPE', 'LogFormatType', 'Log Format', 'Text', 'Server', ['Text', 'Json']),
  e('CROSSPLAY_PLATFORMS', 'CrossplayPlatforms', 'Crossplay Platforms', '(Steam,Xbox,PS5,Mac)', 'Server',
    ['(Steam,Xbox,PS5,Mac)', '(Steam)', '(Steam,Mac)', '(Steam,Xbox)'],
    'Tuple syntax is what the ini expects — do not remove the parentheses.'),
  b('ALLOW_CONNECT_PLATFORM', 'AllowConnectPlatform', 'Allow Cross-Platform Connect', 'true', 'Server'),
  b('SHOW_PLAYER_LIST', 'bShowPlayerList', 'Show Player List', 'true', 'Server'),
  b('IS_SHOW_JOIN_LEFT_MESSAGE', 'bIsShowJoinLeftMessage', 'Show Join/Leave Messages', 'true', 'Server'),
  b('ALLOW_CLIENT_MOD', 'AllowClientMod', 'Allow Client Mods', 'false', 'Server'),

  // Secrets — rendered in the UI, but the values live in a Kubernetes Secret.
  { env: 'ADMIN_PASSWORD', key: 'AdminPassword', label: 'Admin Password', default: '', category: 'Server', type: 'string', secret: true, help: 'Auto-generated on first deploy. Retrieve or rotate it from the credentials endpoint.' },
  { env: 'SERVER_PASSWORD', key: 'ServerPassword', label: 'Server Password', default: '', category: 'Server', type: 'string', secret: true, help: 'Leave unset for an open server. Required to be empty for community-browser listing.' },
  { env: 'RCON_PASSWORD', key: 'RCONPassword', label: 'RCON Password', default: '', category: 'Server', type: 'string', secret: true },

  // Platform-owned — shown greyed out so the ports are discoverable, but not editable.
  { env: 'PORT', key: 'PublicPort', label: 'Game Port (UDP)', default: String(PALWORLD_GAME_PORT), category: 'Server', type: 'int', readonly: true, help: 'Fixed by the platform: the hostPort, Service and cloud firewall rule are all derived from it.' },
  { env: 'RCON_PORT', key: 'RCONPort', label: 'RCON Port (TCP)', default: String(PALWORLD_RCON_PORT), category: 'Server', type: 'int', readonly: true },
  { env: 'REST_API_PORT', key: 'RESTAPIPort', label: 'REST API Port (TCP)', default: String(PALWORLD_REST_PORT), category: 'Server', type: 'int', readonly: true, help: 'Also the health-probe target.' },
  { env: 'PUID', key: '-', label: 'Container UID', default: '1000', category: 'Operational', type: 'int', readonly: true },
  { env: 'PGID', key: '-', label: 'Container GID', default: '1000', category: 'Operational', type: 'int', readonly: true },

  // ── Operational (container behaviour, not PalWorldSettings.ini) ──────────
  s('TZ', '-', 'Timezone', 'UTC', 'Operational'),
  b('UPDATE_ON_BOOT', '-', 'Update Game On Boot', 'true', 'Operational',
    'Runs SteamCMD before starting. Adds minutes to a restart — and every settings save restarts the server.'),
  b('RCON_ENABLED', 'RCONEnabled', 'Enable RCON', 'true', 'Operational',
    'Required for graceful shutdown and world-save on restart. Disabling risks save corruption.'),
  b('REST_API_ENABLED', 'RESTAPIEnabled', 'Enable REST API', 'true', 'Operational',
    'Required — the health probe targets this port.'),
  b('AUTO_REBOOT_ENABLED', '-', 'Enable Auto Reboot', 'false', 'Operational'),
  b('AUTO_UPDATE_ENABLED', '-', 'Enable Auto Update', 'false', 'Operational'),
  b('AUTO_PAUSE_ENABLED', '-', 'Pause When Empty', 'false', 'Operational'),
  b('MULTITHREADING', '-', 'Multithreading', 'true', 'Operational'),
  i('AUTO_SAVE_SPAN', 'AutoSaveSpan', 'Autosave Interval (s)', '30', 'Operational', 1),

  // ── Backup ───────────────────────────────────────────────────────────────
  b('BACKUP_ENABLED', '-', 'Enable Backups', 'true', 'Backup'),
  s('BACKUP_CRON_EXPRESSION', '-', 'Backup Schedule (cron)', '0 0 * * *', 'Backup'),
  i('DELETE_OLD_BACKUPS_DAYS', '-', 'Delete Backups Older Than (days)', '0', 'Backup', 0, undefined, '0 keeps them forever.'),
  b('USE_BACKUP_SAVE_DATA', 'bUseBackupSaveData', 'Use Backup Save Data', 'true', 'Backup'),

  // ── Gameplay ─────────────────────────────────────────────────────────────
  e('DIFFICULTY', 'Difficulty', 'Difficulty', 'None', 'Gameplay', ['None', 'Casual', 'Normal', 'Hard']),
  b('IS_MULTIPLAY', 'bIsMultiplay', 'Multiplayer', 'false', 'Gameplay'),
  b('HARDCORE', 'bHardcore', 'Hardcore', 'false', 'Gameplay'),
  b('PAL_LOST', 'bPalLost', 'Pals Lost On Death', 'false', 'Gameplay'),
  b('CHARACTER_RECREATE_IN_HARDCORE', 'bCharacterRecreateInHardcore', 'Recreate Character In Hardcore', 'false', 'Gameplay'),
  e('DEATH_PENALTY', 'DeathPenalty', 'Death Penalty', 'All', 'Gameplay', ['None', 'Item', 'ItemAndEquipment', 'All']),
  b('ENABLE_FAST_TRAVEL', 'bEnableFastTravel', 'Enable Fast Travel', 'true', 'Gameplay'),
  b('IS_START_LOCATION_SELECT_BY_MAP', 'bIsStartLocationSelectByMap', 'Select Start Location On Map', 'true', 'Gameplay'),
  b('EXIST_PLAYER_AFTER_LOGOUT', 'bExistPlayerAfterLogout', 'Player Persists After Logout', 'false', 'Gameplay'),
  b('ENABLE_NON_LOGIN_PENALTY', 'bEnableNonLoginPenalty', 'Non-Login Penalty', 'true', 'Gameplay'),
  b('ENABLE_INVADER_ENEMY', 'bEnableInvaderEnemy', 'Enable Raids', 'true', 'Gameplay'),
  b('ACTIVE_UNKO', 'bActiveUNKO', 'Enable UNKO', 'false', 'Gameplay'),
  b('ENABLE_AIM_ASSIST_PAD', 'bEnableAimAssistPad', 'Aim Assist (Controller)', 'true', 'Gameplay'),
  b('ENABLE_AIM_ASSIST_KEYBOARD', 'bEnableAimAssistKeyboard', 'Aim Assist (Keyboard)', 'false', 'Gameplay'),
  b('ENABLE_PREDATOR_BOSS_PAL', 'bEnablePredatorBossPal', 'Enable Predator Pals', 'true', 'Gameplay'),
  i('SUPPLY_DROP_SPAN', 'SupplyDropSpan', 'Supply Drop Interval (min)', '180', 'Gameplay', 0),
  i('CHAT_POST_LIMIT_PER_MINUTE', 'ChatPostLimitPerMinute', 'Chat Rate Limit (per min)', '30', 'Gameplay', 1),
  b('ENABLE_VOICE_CHAT', 'bEnableVoiceChat', 'Enable Voice Chat', 'true', 'Gameplay'),
  f('VOICE_CHAT_MAX_VOLUME_DISTANCE', 'VoiceChatMaxVolumeDistance', 'Voice Max Volume Distance', '500.0', 'Gameplay', 0),
  f('VOICE_CHAT_ZERO_VOLUME_DISTANCE', 'VoiceChatZeroVolumeDistance', 'Voice Zero Volume Distance', '2000.0', 'Gameplay', 0),
  e('RANDOMIZER_TYPE', 'RandomizerType', 'Randomizer Type', 'None', 'Gameplay', ['None', 'Region', 'All']),
  s('RANDOMIZER_SEED', 'RandomizerSeed', 'Randomizer Seed', '', 'Gameplay'),
  b('IS_RANDOMIZER_PAL_LEVEL_RANDOM', 'bIsRandomizerPalLevelRandom', 'Randomize Pal Levels', 'false', 'Gameplay'),

  // ── Rates ────────────────────────────────────────────────────────────────
  f('DAYTIME_SPEEDRATE', 'DayTimeSpeedRate', 'Day Speed', '1.000000', 'Rates', 0.1, 5),
  f('NIGHTTIME_SPEEDRATE', 'NightTimeSpeedRate', 'Night Speed', '1.000000', 'Rates', 0.1, 5),
  f('EXP_RATE', 'ExpRate', 'EXP Rate', '1.000000', 'Rates', 0.1, 20),
  f('PAL_CAPTURE_RATE', 'PalCaptureRate', 'Pal Capture Rate', '1.000000', 'Rates', 0.5, 2),
  f('PAL_SPAWN_NUM_RATE', 'PalSpawnNumRate', 'Pal Spawn Rate', '1.000000', 'Rates', 0.5, 3),
  f('COLLECTION_DROP_RATE', 'CollectionDropRate', 'Gather Amount', '1.000000', 'Rates', 0.5, 3),
  f('COLLECTION_OBJECT_HP_RATE', 'CollectionObjectHpRate', 'Gatherable Object HP', '1.000000', 'Rates', 0.5, 3),
  f('COLLECTION_OBJECT_RESPAWN_SPEED_RATE', 'CollectionObjectRespawnSpeedRate', 'Gatherable Respawn Speed', '1.000000', 'Rates', 0.5, 3),
  f('ENEMY_DROP_ITEM_RATE', 'EnemyDropItemRate', 'Enemy Drop Rate', '1.000000', 'Rates', 0.5, 3),
  f('WORK_SPEED_RATE', 'WorkSpeedRate', 'Work Speed', '1.000000', 'Rates', 0.1, 5),
  f('ITEM_WEIGHT_RATE', 'ItemWeightRate', 'Item Weight Rate', '1.000000', 'Rates', 0, 5),
  f('PAL_EGG_DEFAULT_HATCHING_TIME', 'PalEggDefaultHatchingTime', 'Egg Hatch Time (h)', '72.000000', 'Rates', 0),
  f('EQUIPMENT_DURABILITY_DAMAGE_RATE', 'EquipmentDurabilityDamageRate', 'Equipment Durability Damage', '1.000000', 'Rates', 0, 5),
  f('ITEM_CORRUPTION_MULTIPLIER', 'ItemCorruptionMultiplier', 'Item Corruption Multiplier', '1.000000', 'Rates', 0, 5),
  f('MONSTER_FARM_ACTION_SPEED_RATE', 'MonsterFarmActionSpeedRate', 'Ranch Action Speed', '1.000000', 'Rates', 0.1, 5),

  // ── Combat ───────────────────────────────────────────────────────────────
  f('PLAYER_DAMAGE_RATE_ATTACK', 'PlayerDamageRateAttack', 'Player Damage Dealt', '1.000000', 'Combat', 0.1, 5),
  f('PLAYER_DAMAGE_RATE_DEFENSE', 'PlayerDamageRateDefense', 'Player Damage Taken', '1.000000', 'Combat', 0.1, 5),
  f('PLAYER_STOMACH_DECREASE_RATE', 'PlayerStomachDecreaseRate', 'Player Hunger Rate', '1.000000', 'Combat', 0, 5),
  f('PLAYER_STAMINA_DECREASE_RATE', 'PlayerStaminaDecreaseRate', 'Player Stamina Drain', '1.000000', 'Combat', 0, 5),
  f('PLAYER_AUTO_HP_REGEN_RATE', 'PlayerAutoHPRegeneRate', 'Player HP Regen', '1.000000', 'Combat', 0, 5),
  f('PLAYER_AUTO_HP_REGEN_RATE_IN_SLEEP', 'PlayerAutoHpRegeneRateInSleep', 'Player HP Regen (Sleep)', '1.000000', 'Combat', 0, 5),
  b('ENABLE_PLAYER_TO_PLAYER_DAMAGE', 'bEnablePlayerToPlayerDamage', 'Player vs Player Damage', 'false', 'Combat'),
  b('ENABLE_FRIENDLY_FIRE', 'bEnableFriendlyFire', 'Friendly Fire', 'false', 'Combat'),
  i('BLOCK_RESPAWN_TIME', 'BlockRespawnTime', 'Respawn Block Time (s)', '0', 'Combat', 0),
  f('RESPAWN_PENALTY_DURATION_THRESHOLD', 'RespawnPenaltyDurationThreshold', 'Respawn Penalty Threshold', '0.000000', 'Combat', 0),
  f('RESPAWN_PENALTY_TIME_SCALE', 'RespawnPenaltyTimeScale', 'Respawn Penalty Time Scale', '1.000000', 'Combat', 0),

  // ── Pals ─────────────────────────────────────────────────────────────────
  f('PAL_DAMAGE_RATE_ATTACK', 'PalDamageRateAttack', 'Pal Damage Dealt', '1.000000', 'Pals', 0.1, 5),
  f('PAL_DAMAGE_RATE_DEFENSE', 'PalDamageRateDefense', 'Pal Damage Taken', '1.000000', 'Pals', 0.1, 5),
  f('PAL_STOMACH_DECREASE_RATE', 'PalStomachDecreaseRate', 'Pal Hunger Rate', '1.000000', 'Pals', 0, 5),
  f('PAL_STAMINA_DECREASE_RATE', 'PalStaminaDecreaseRate', 'Pal Stamina Drain', '1.000000', 'Pals', 0, 5),
  f('PAL_AUTO_HP_REGEN_RATE', 'PalAutoHPRegeneRate', 'Pal HP Regen', '1.000000', 'Pals', 0, 5),
  f('PAL_AUTO_HP_REGEN_RATE_IN_SLEEP', 'PalAutoHpRegeneRateInSleep', 'Pal HP Regen (Sleep)', '1.000000', 'Pals', 0, 5),
  b('ALLOW_GLOBAL_PALBOX_EXPORT', 'bAllowGlobalPalboxExport', 'Allow Palbox Export', 'true', 'Pals'),
  b('ALLOW_GLOBAL_PALBOX_IMPORT', 'bAllowGlobalPalboxImport', 'Allow Palbox Import', 'false', 'Pals'),
  b('ALLOW_ENHANCE_STAT_HEALTH', 'AllowEnhanceStatHealth', 'Allow Health Enhancement', 'true', 'Pals'),
  b('ALLOW_ENHANCE_STAT_ATTACK', 'AllowEnhanceStatAttack', 'Allow Attack Enhancement', 'true', 'Pals'),
  b('ALLOW_ENHANCE_STAT_STAMINA', 'AllowEnhanceStatStamina', 'Allow Stamina Enhancement', 'true', 'Pals'),
  b('ALLOW_ENHANCE_STAT_WEIGHT', 'AllowEnhanceStatWeight', 'Allow Weight Enhancement', 'true', 'Pals'),
  b('ALLOW_ENHANCE_STAT_WORK_SPEED', 'AllowEnhanceStatWorkSpeed', 'Allow Work Speed Enhancement', 'true', 'Pals'),

  // ── Building ─────────────────────────────────────────────────────────────
  f('BUILD_OBJECT_HP_RATE', 'BuildObjectHpRate', 'Structure HP', '1.000000', 'Building', 0.5, 3),
  f('BUILD_OBJECT_DAMAGE_RATE', 'BuildObjectDamageRate', 'Structure Damage', '1.000000', 'Building', 0.5, 3),
  f('BUILD_OBJECT_DETERIORATION_DAMAGE_RATE', 'BuildObjectDeteriorationDamageRate', 'Structure Deterioration', '1.000000', 'Building', 0, 3),
  i('MAX_BUILDING_LIMIT_NUM', 'MaxBuildingLimitNum', 'Max Buildings (0 = unlimited)', '0', 'Building', 0),
  b('BUILD_AREA_LIMIT', 'BuildAreaLimit', 'Build Area Limit', 'false', 'Building'),
  i('BASE_CAMP_MAX_NUM', 'BaseCampMaxNum', 'Max Base Camps', '128', 'Building', 1),
  i('BASE_CAMP_WORKER_MAX_NUM', 'BaseCampWorkerMaxNum', 'Max Base Camp Workers', '15', 'Building', 1),
  i('DROP_ITEM_MAX_NUM', 'DropItemMaxNum', 'Max Dropped Items', '3000', 'Building', 1),
  i('DROP_ITEM_MAX_NUM_UNKO', 'DropItemMaxNum_UNKO', 'Max Dropped UNKO', '100', 'Building', 1),
  f('DROP_ITEM_ALIVE_MAX_HOURS', 'DropItemAliveMaxHours', 'Dropped Item Lifetime (h)', '1.000000', 'Building', 0),
  i('PHYSICS_ACTIVE_DROP_ITEM_MAX_NUM', 'PhysicsActiveDropItemMaxNum', 'Max Physics-Active Drops', '250', 'Building', 1),
  b('ENABLE_BUILDING_PLAYER_UID_DISPLAY', 'bEnableBuildingPlayerUIdDisplay', 'Show Builder UID', 'false', 'Building'),
  i('BUILDING_NAME_DISPLAY_CACHE_TTL_SECONDS', 'BuildingNameDisplayCacheTTLSeconds', 'Builder Name Cache TTL (s)', '60', 'Building', 0),

  // ── Guild ────────────────────────────────────────────────────────────────
  i('GUILD_PLAYER_MAX_NUM', 'GuildPlayerMaxNum', 'Max Guild Members', '20', 'Guild', 1),
  i('BASE_CAMP_MAX_NUM_IN_GUILD', 'BaseCampMaxNumInGuild', 'Max Base Camps Per Guild', '4', 'Guild', 1),
  b('AUTO_RESET_GUILD_NO_ONLINE_PLAYERS', 'bAutoResetGuildNoOnlinePlayers', 'Auto-Reset Inactive Guilds', 'false', 'Guild'),
  f('AUTO_RESET_GUILD_TIME_NO_ONLINE_PLAYERS', 'AutoResetGuildTimeNoOnlinePlayers', 'Guild Reset After (h)', '72.000000', 'Guild', 0),
  i('GUILD_REJOIN_COOLDOWN_MINUTES', 'GuildRejoinCooldownMinutes', 'Guild Rejoin Cooldown (min)', '0', 'Guild', 0),
  b('ENABLE_DEFENSE_OTHER_GUILD_PLAYER', 'bEnableDefenseOtherGuildPlayer', 'Defend Against Other Guilds', 'false', 'Guild'),
  b('INVISIBLE_OTHER_GUILD_BASE_CAMP_AREA_FX', 'bInvisibleOtherGuildBaseCampAreaFX', 'Hide Other Guild Base FX', 'false', 'Guild'),
  b('CAN_PICKUP_OTHER_GUILD_DEATH_PENALTY_DROP', 'bCanPickupOtherGuildDeathPenaltyDrop', 'Loot Other Guild Death Drops', 'false', 'Guild'),
  i('AUTO_TRANSFER_MASTER_CHECK_INTERVAL_SECONDS', 'AutoTransferMasterCheckIntervalSeconds', 'Guild Master Transfer Check (s)', '3600', 'Guild', 0),
  i('AUTO_TRANSFER_MASTER_THRESHOLD_DAYS', 'AutoTransferMasterThresholdDays', 'Guild Master Transfer After (days)', '7', 'Guild', 0),

  // ── PvP ──────────────────────────────────────────────────────────────────
  b('IS_PVP', 'bIsPvP', 'Enable PvP', 'false', 'PvP'),
  i('COOP_PLAYER_MAX_NUM', 'CoopPlayerMaxNum', 'Max Co-op Players', '4', 'PvP', 1),
  b('DISPLAY_PVP_ITEM_NUM_ON_WORLD_MAP_BASE_CAMP', 'bDisplayPvPItemNumOnWorldMapBaseCamp', 'Show PvP Items (Base Camp)', 'false', 'PvP'),
  b('DISPLAY_PVP_ITEM_NUM_ON_WORLD_MAP_PLAYER', 'bDisplayPvPItemNumOnWorldMapPlayer', 'Show PvP Items (Player)', 'false', 'PvP'),
  b('ADDITIONAL_DROP_ITEM_WHEN_PLAYER_KILLING_IN_PVP_MODE_ENABLED', 'bAdditionalDropItemWhenPlayerKillingInPvPModeEnabled', 'Extra PvP Kill Drops', 'false', 'PvP'),
  s('ADDITIONAL_DROP_ITEM_WHEN_PLAYER_KILLING_IN_PVP_MODE', 'AdditionalDropItemWhenPlayerKillingInPvPMode', 'Extra PvP Drop Item', '', 'PvP'),
  i('ADDITIONAL_DROP_ITEM_NUM_WHEN_PLAYER_KILLING_IN_PVP_MODE', 'AdditionalDropItemNumWhenPlayerKillingInPvPMode', 'Extra PvP Drop Count', '0', 'PvP', 0),

  // ── Advanced / performance ───────────────────────────────────────────────
  f('SERVER_REPLICATE_PAWN_CULL_DISTANCE', 'ServerReplicatePawnCullDistance', 'Pawn Cull Distance', '15000.000000', 'Advanced', 5000, 30000,
    'Lowering this reduces CPU load on busy servers at the cost of draw distance for other players/pals.'),
  i('ITEM_CONTAINER_FORCE_MARK_DIRTY_INTERVAL', 'ItemContainerForceMarkDirtyInterval', 'Container Dirty Interval (s)', '1', 'Advanced', 0),
  i('PLAYER_DATA_PAL_STORAGE_UPDATE_CHECK_TICK_INTERVAL', 'PlayerDataPalStorageUpdateCheckTickInterval', 'Pal Storage Check Interval', '10', 'Advanced', 0),
  i('MAX_GUILDS_PER_FRAME', 'MaxGuildsPerFrame', 'Max Guilds Processed Per Frame', '10', 'Advanced', 1),
  s('DENY_TECHNOLOGY_LIST', 'DenyTechnologyList', 'Denied Technologies', '', 'Advanced'),
  e('LOG_LEVEL', '-', 'Container Log Level', 'info', 'Advanced', ['trace', 'debug', 'info', 'warn', 'error']),
];

export const PALWORLD_SCHEMA: AppSettingsSchema = {
  appType: 'palworld',
  categories: [...PALWORLD_CATEGORIES],
  settings: SETTINGS,
};
