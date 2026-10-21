# Saves Enhanced Input assets with non-default parameters through Unreal's own editor APIs, so the
# scan v2 projection can be checked against packages a real engine wrote. Run by
# scripts/probe-enhanced-input-unreal.ts inside a disposable project; it never touches the fixture.
import unreal

ROOT = "/Game/Probe"
tools = unreal.AssetToolsHelpers.get_asset_tools()


def data_asset(name, cls):
    factory = unreal.DataAssetFactory()
    factory.set_editor_property("data_asset_class", cls)
    asset = tools.create_asset(name, ROOT, cls, factory)
    if asset is None:
        raise RuntimeError(f"Could not create {name}")
    return asset


def instanced(cls, outer, object_name, **properties):
    # Unreal treats an edit-inline object inside an asset as a template and refuses
    # EditInstanceOnly properties such as ChordAction there. Set the properties while the object
    # is still transient, then move it into the asset that saves it.
    value = unreal.new_object(cls)
    for property_name, property_value in properties.items():
        value.set_editor_property(property_name, property_value)
    if not value.rename(object_name, outer):
        raise RuntimeError(f"Could not move {object_name} into {outer.get_path_name()}")
    return value


def key(name):
    value = unreal.Key()
    value.import_text(name)
    return value


def mapping(action, key_name, triggers=(), modifiers=(), **properties):
    result = unreal.EnhancedActionKeyMapping()
    result.set_editor_property("action", action)
    result.set_editor_property("key", key(key_name))
    result.set_editor_property("triggers", list(triggers))
    result.set_editor_property("modifiers", list(modifiers))
    for name, value in properties.items():
        result.set_editor_property(name, value)
    return result


def mapping_data(mappings):
    result = unreal.InputMappingContextMappingData()
    result.set_editor_property("mappings", mappings)
    return result


def settings(outer, name, display):
    return instanced(
        unreal.PlayerMappableKeySettings,
        outer,
        f"PlayerMappableKeySettings_{name}",
        name=name,
        display_name=display,
        supported_key_profile_ids=["Default"],
    )


fire = data_asset("IA_Fire", unreal.InputAction)
aim = data_asset("IA_Aim", unreal.InputAction)
jump = data_asset("IA_Jump", unreal.InputAction)
brake = data_asset("IA_Brake", unreal.InputAction)
unused = data_asset("IA_Unused", unreal.InputAction)

fire.set_editor_property("action_description", "Fire weapon")
fire.set_editor_property("trigger_when_paused", True)
fire.set_editor_property("reserve_all_mappings", True)
fire.set_editor_property(
    "accumulation_behavior", unreal.InputActionAccumulationBehavior.CUMULATIVE
)
fire.set_editor_property(
    "triggers", [instanced(unreal.InputTriggerPulse, fire, "InputTriggerPulse_0", interval=0.25)]
)
fire.set_editor_property("player_mappable_key_settings", settings(fire, "Fire", "Fire"))
brake.set_editor_property("consume_input", False)

gameplay = data_asset("IMC_ProbeGameplay", unreal.InputMappingContext)
vehicle = data_asset("IMC_ProbeVehicle", unreal.InputMappingContext)

chord = instanced(
    unreal.InputTriggerChordAction,
    gameplay,
    "InputTriggerChordAction_0",
    chord_action=aim,
    actuation_threshold=0.3,
)
hold = instanced(
    unreal.InputTriggerHold,
    gameplay,
    "InputTriggerHold_1",
    hold_time_threshold=0.4,
    is_one_shot=True,
)
dead_zone = instanced(
    unreal.InputModifierDeadZone,
    gameplay,
    "InputModifierDeadZone_1_0",
    lower_threshold=0.3,
    type=unreal.DeadZoneType.AXIAL,
)
scalar = instanced(
    unreal.InputModifierScalar,
    gameplay,
    "InputModifierScalar_1_1",
    scalar=unreal.Vector(2.0, 1.0, 1.0),
)

gameplay.set_editor_property(
    "default_key_mappings",
    mapping_data(
        [
            mapping(
                fire,
                "LeftMouseButton",
                triggers=[chord],
                setting_behavior=unreal.PlayerMappableKeySettingBehaviors.OVERRIDE_SETTINGS,
                player_mappable_key_settings=settings(gameplay, "FireOverride", "Fire (combat)"),
            ),
            mapping(aim, "RightMouseButton", triggers=[hold], modifiers=[dead_zone, scalar]),
            mapping(jump, "SpaceBar"),
        ]
    ),
)
gameplay.set_editor_property(
    "mapping_profile_overrides",
    {"LeftHanded": mapping_data([mapping(fire, "RightMouseButton")])},
)
gameplay.set_editor_property(
    "registration_tracking_mode",
    unreal.MappingContextRegistrationTrackingMode.COUNT_REGISTRATIONS,
)
gameplay.set_editor_property(
    "input_mode_filter_options", unreal.MappingContextInputModeFilterOptions.DO_NOT_FILTER
)

vehicle.set_editor_property(
    "default_key_mappings",
    mapping_data([mapping(brake, "SpaceBar"), mapping(aim, "RightMouseButton")]),
)

config = data_asset("PMI_Probe", unreal.PlayerMappableInputConfig)
config.set_editor_property("config_name", "ProbeConfig")
config.set_editor_property("config_display_name", "Probe controls")
config.set_editor_property("contexts", {gameplay: 2})

blueprint_factory = unreal.BlueprintFactory()
blueprint_factory.set_editor_property("parent_class", unreal.EnhancedInputPlatformData)
platform_data = tools.create_asset(
    "BP_ProbePlatformData", ROOT, unreal.Blueprint, blueprint_factory
)
unreal.BlueprintEditorLibrary.compile_blueprint(platform_data)
defaults = unreal.get_default_object(platform_data.generated_class())
defaults.set_editor_property("mapping_context_redirects", {vehicle: gameplay})

for asset in [fire, aim, jump, brake, unused, gameplay, vehicle, config, platform_data]:
    if not unreal.EditorAssetLibrary.save_loaded_asset(asset, False):
        raise RuntimeError(f"Could not save {asset.get_path_name()}")

unreal.log("UE Shed Enhanced Input probe saved its assets")
