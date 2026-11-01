#include "UEShedCoverageBatchFixture.h"
#include "UEShedNativeParserTypes.h"
#include "Dom/JsonObject.h"
#include "SubObjectLocator.h"
#include "DirectPathObjectLocator.h"
#include "UniversalObjectLocators/ActorLocatorFragment.h"
#include "UniversalObjectLocators/AnimInstanceLocatorFragment.h"

namespace
{
TArray<TSharedPtr<FJsonValue>> Numbers(std::initializer_list<double> Values)
{
	TArray<TSharedPtr<FJsonValue>> Result;
	for (double Value : Values) Result.Add(MakeShared<FJsonValueNumber>(Value));
	return Result;
}

TSharedRef<FJsonObject> VariableEvidence(const FNiagaraVariableBase& Variable)
{
	auto Result = MakeShared<FJsonObject>();
	Result->SetStringField(TEXT("name"), Variable.GetName().ToString());
	Result->SetStringField(TEXT("type"), Variable.GetType().GetScriptStruct()->GetPathName());
	return Result;
}
}

void FillCoverageBatchFixture(UUEShedCoverageBatchAsset* Asset, UObject* Reference)
{
	Asset->Cell2D = FIntVector2(MIN_int32, MAX_int32);
	Asset->Direction4f = FVector4f(-0.125f, 1.0f / 3.0f, 16777216.0f, -8.5f);
	Asset->Bounds2f = FBox2f(FVector2f(-4.25f, -8.5f), FVector2f(16.0f, 32.5f));
	Asset->Cells2D = {Asset->Cell2D, FIntVector2(7, -9)};
	Asset->Directions4f = {Asset->Direction4f, FVector4f(1, 2, 3, 4)};
	Asset->Rectangles2f = {Asset->Bounds2f, FBox2f(ForceInit)};
	Asset->AliasInstances.Reset();
	const auto AddAlias = [&](const TCHAR* Name, const void* Value)
	{
		FInstancedStruct Instance;
		Instance.InitializeAs(FindObjectChecked<UScriptStruct>(nullptr, Name), static_cast<const uint8*>(Value));
		Asset->AliasInstances.Add(Instance);
	};
	AddAlias(TEXT("/Script/CoreUObject.IntVector2"), &Asset->Cell2D);
	AddAlias(TEXT("/Script/CoreUObject.Vector4f"), &Asset->Direction4f);
	AddAlias(TEXT("/Script/CoreUObject.Box2f"), &Asset->Bounds2f);
	Asset->CategoryText = FText::Format(NSLOCTEXT("UEShedCoverage", "OrderedCategory", "{0}|{1}"), FText::FromString(TEXT("Fixture")), FText::FromString(TEXT("Category")));
	FFormatNamedArguments Named;
	Named.Add(TEXT("Root"), FText::FromString(TEXT("Fixture")));
	Named.Add(TEXT("Leaf"), FText::FromString(TEXT("Named")));
	Asset->NamedCategoryText = FText::Format(NSLOCTEXT("UEShedCoverage", "NamedCategory", "{Root}|{Leaf}"), Named);
	Asset->EscapedFormatText = FText::Format(NSLOCTEXT("UEShedCoverage", "Escaped", "`{literal`} {0} `| ``"), FText::FromString(TEXT("Fixture")));
	Asset->OptionalUnset.Reset();
	Asset->OptionalFalse = false;
	Asset->OptionalTrue = true;
	Asset->OptionalText = Asset->CategoryText;
	Asset->LocatorFragments.Reset();
	FSubObjectLocator Subobject;
	Subobject.PathWithinContext = TEXT("FixtureComponent");
	Asset->LocatorFragments.Emplace(FSubObjectLocator::FragmentType, Subobject);
	FActorLocatorFragment Actor;
	Actor.Path = FSoftObjectPath(TEXT("/Game/Fixture/Worlds/FixtureMap.FixtureMap:PersistentLevel.FixtureActor"));
	Asset->LocatorFragments.Emplace(FActorLocatorFragment::FragmentType, Actor);
	Asset->LocatorFragments.Emplace(FAnimInstanceLocatorFragment::FragmentType, EAnimInstanceLocatorFragmentType::PostProcessAnimInstance);
	FDirectPathObjectLocator Direct;
	Direct.Path = FSoftObjectPath(Reference);
	Asset->LocatorFragments.Emplace(FDirectPathObjectLocator::FragmentType, Direct);
	Asset->LocatorFragments.Emplace();
	Asset->BaseVariable = FNiagaraVariableBase(FNiagaraTypeDefinition::GetIntDef(), TEXT("Fixture.Base"));
	Asset->DataVariable = FNiagaraVariable(FNiagaraTypeDefinition::GetFloatDef(), TEXT("Fixture.Value"));
	Asset->DataVariable.SetValue<float>(1.25f);
	Asset->OffsetVariable = FNiagaraVariableWithOffset(Asset->BaseVariable, 24, FNiagaraLwcStructConverter());
	Asset->VariableRecords = {Asset->DataVariable, FNiagaraVariable(FNiagaraTypeDefinition::GetIntDef(), TEXT("Fixture.Empty"))};
	Asset->ExternalFunction.Name = TEXT("FixtureFunction");
	Asset->ExternalFunction.OwnerName = TEXT("FixtureOwner");
	Asset->ExternalFunction.InputParamLocations = {true, false, true};
	Asset->ExternalFunction.NumOutputs = 2;
	Asset->ExternalFunction.FunctionSpecifiers = {FVMFunctionSpecifier(TEXT("Mode"), TEXT("Fixture"))};
	Asset->ExternalFunction.VariadicInputs = {Asset->BaseVariable};
	Asset->ExternalFunction.VariadicOutputs = {FNiagaraVariableBase(Asset->DataVariable)};
	Asset->ExternalFunctions = {Asset->ExternalFunction};
	Asset->LandscapeLayers.Reset();
	FLandscapeLayerComponentData Layer(TEXT("Fixture.Painted"));
	Layer.WeightmapData.Textures.Add(nullptr);
	FWeightmapLayerAllocationInfo Allocation;
	Allocation.WeightmapTextureIndex = 3;
	Allocation.WeightmapTextureChannel = 2;
	Layer.WeightmapData.LayerAllocations.Add(Allocation);
	Asset->LandscapeLayers.Add(FGuid(1, 2, 3, 4), Layer);
	Asset->LandscapeLayers.Add(FGuid(5, 6, 7, 8), FLandscapeLayerComponentData(TEXT("Fixture.Empty")));
	Asset->Constraint.JointName = TEXT("FixtureJoint");
	Asset->Constraint.ConstraintBone1 = TEXT("Root");
	Asset->Constraint.ConstraintBone2 = TEXT("Tip");
	Asset->Constraint.Pos1 = FVector(-1.25, 2.5, 3.75);
	Asset->Constraint.Pos2 = FVector(8, -16, 32);
	auto& Profile = Asset->Constraint.ProfileInstance;
	Profile.bDisableCollision = true;
	Profile.bLinearBreakable = true;
	Profile.LinearBreakThreshold = 5123.75f;
	Profile.LinearLimit.XMotion = LCM_Limited;
	Profile.LinearLimit.Limit = 27.5f;
	Profile.LinearLimit.bSoftConstraint = true;
	Profile.LinearLimit.Stiffness = 321.0f;
	Profile.LinearLimit.Damping = 17.25f;
	Profile.ConeLimit.Swing1Motion = ACM_Limited;
	Profile.ConeLimit.Swing1LimitDegrees = 37.5f;
	Asset->Constraints = {Asset->Constraint, FConstraintInstance()};
}

TSharedRef<FJsonObject> CoverageBatchFixtureEvidence(const UUEShedCoverageBatchAsset* Asset)
{
	auto Result = MakeShared<FJsonObject>();
	Result->SetArrayField(TEXT("cell"), Numbers({double(Asset->Cell2D.X), double(Asset->Cell2D.Y)}));
	Result->SetArrayField(TEXT("direction"), Numbers({Asset->Direction4f.X, Asset->Direction4f.Y, Asset->Direction4f.Z, Asset->Direction4f.W}));
	Result->SetArrayField(TEXT("bounds_min"), Numbers({Asset->Bounds2f.Min.X, Asset->Bounds2f.Min.Y}));
	Result->SetArrayField(TEXT("bounds_max"), Numbers({Asset->Bounds2f.Max.X, Asset->Bounds2f.Max.Y}));
	Result->SetBoolField(TEXT("bounds_valid"), Asset->Bounds2f.bIsValid != 0);
	Result->SetStringField(TEXT("ordered_text"), Asset->CategoryText.ToString());
	Result->SetStringField(TEXT("named_text"), Asset->NamedCategoryText.ToString());
	Result->SetStringField(TEXT("escaped_text"), Asset->EscapedFormatText.ToString());
	Result->SetBoolField(TEXT("optional_unset"), Asset->OptionalUnset.IsSet());
	Result->SetBoolField(TEXT("optional_false"), Asset->OptionalFalse.GetValue());
	Result->SetBoolField(TEXT("optional_true"), Asset->OptionalTrue.GetValue());
	Result->SetStringField(TEXT("optional_text"), Asset->OptionalText.GetValue().ToString());
	Result->SetStringField(TEXT("subobject_path"), Asset->LocatorFragments[0].GetPayloadAs(FSubObjectLocator::FragmentType)->PathWithinContext);
	Result->SetStringField(TEXT("actor_path"), Asset->LocatorFragments[1].GetPayloadAs(FActorLocatorFragment::FragmentType)->Path.ToString());
	Result->SetNumberField(TEXT("anim_instance_type"), int32(Asset->LocatorFragments[2].GetPayloadAs(FAnimInstanceLocatorFragment::FragmentType)->Type));
	Result->SetStringField(TEXT("direct_path"), Asset->LocatorFragments[3].GetPayloadAs(FDirectPathObjectLocator::FragmentType)->Path.ToString());
	Result->SetBoolField(TEXT("empty_fragment"), Asset->LocatorFragments[4].IsEmpty());
	Result->SetObjectField(TEXT("base_variable"), VariableEvidence(Asset->BaseVariable));
	Result->SetObjectField(TEXT("data_variable"), VariableEvidence(Asset->DataVariable));
	Result->SetNumberField(TEXT("data_value"), Asset->DataVariable.GetValue<float>());
	Result->SetNumberField(TEXT("variable_offset"), Asset->OffsetVariable.Offset);
	auto Function = MakeShared<FJsonObject>();
	Function->SetStringField(TEXT("name"), Asset->ExternalFunction.Name.ToString());
	Function->SetStringField(TEXT("owner"), Asset->ExternalFunction.OwnerName.ToString());
	TArray<TSharedPtr<FJsonValue>> Locations;
	for (bool Location : Asset->ExternalFunction.InputParamLocations) Locations.Add(MakeShared<FJsonValueBoolean>(Location));
	Function->SetArrayField(TEXT("inputs"), Locations);
	Function->SetNumberField(TEXT("outputs"), Asset->ExternalFunction.NumOutputs);
	Function->SetStringField(TEXT("specifier"), Asset->ExternalFunction.FunctionSpecifiers[0].Value.ToString());
	Result->SetObjectField(TEXT("function"), Function);
	return Result;
}

TSharedRef<FJsonObject> LandscapeConstraintFixtureEvidence(const UUEShedCoverageBatchAsset* Asset)
{
	auto Result = MakeShared<FJsonObject>();
	// Check the real engine declaration independently of the fixture's own map.
	const FMapProperty* Map = FindFProperty<FMapProperty>(ULandscapeComponent::StaticClass(), TEXT("LayersData"));
	check(Map);
	check(CastFieldChecked<FStructProperty>(Map->KeyProp)->Struct == TBaseStructure<FGuid>::Get());
	check(CastFieldChecked<FStructProperty>(Map->ValueProp)->Struct == FLandscapeLayerComponentData::StaticStruct());
	TArray<FGuid> Keys;
	Asset->LandscapeLayers.GetKeys(Keys);
	Keys.Sort([](const FGuid& A, const FGuid& B) { return A.ToString() < B.ToString(); });
	TArray<TSharedPtr<FJsonValue>> Layers;
	for (const FGuid& Key : Keys)
	{
		const auto& Layer = Asset->LandscapeLayers.FindChecked(Key);
		auto Item = MakeShared<FJsonObject>();
		Item->SetArrayField(TEXT("guid"), Numbers({double(Key.A), double(Key.B), double(Key.C), double(Key.D)}));
		Item->SetStringField(TEXT("debug_name"), Layer.DebugName.ToString());
		Item->SetNumberField(TEXT("weight_texture_count"), Layer.WeightmapData.Textures.Num());
		TArray<TSharedPtr<FJsonValue>> Allocations;
		for (const auto& Allocation : Layer.WeightmapData.LayerAllocations)
		{
			auto Value = MakeShared<FJsonObject>();
			Value->SetNumberField(TEXT("texture_index"), Allocation.WeightmapTextureIndex);
			Value->SetNumberField(TEXT("channel"), Allocation.WeightmapTextureChannel);
			Allocations.Add(MakeShared<FJsonValueObject>(Value));
		}
		Item->SetArrayField(TEXT("allocations"), Allocations);
		Layers.Add(MakeShared<FJsonValueObject>(Item));
	}
	Result->SetArrayField(TEXT("layers"), Layers);
	const auto& Constraint = Asset->Constraint;
	const auto& Profile = Constraint.ProfileInstance;
	auto Joint = MakeShared<FJsonObject>();
	Joint->SetStringField(TEXT("joint"), Constraint.JointName.ToString());
	Joint->SetStringField(TEXT("bone1"), Constraint.ConstraintBone1.ToString());
	Joint->SetStringField(TEXT("bone2"), Constraint.ConstraintBone2.ToString());
	Joint->SetArrayField(TEXT("pos1"), Numbers({Constraint.Pos1.X, Constraint.Pos1.Y, Constraint.Pos1.Z}));
	Joint->SetArrayField(TEXT("pos2"), Numbers({Constraint.Pos2.X, Constraint.Pos2.Y, Constraint.Pos2.Z}));
	Joint->SetBoolField(TEXT("disable_collision"), Profile.bDisableCollision);
	Joint->SetBoolField(TEXT("linear_breakable"), Profile.bLinearBreakable);
	Joint->SetNumberField(TEXT("break_threshold"), Profile.LinearBreakThreshold);
	Joint->SetStringField(TEXT("x_motion"), StaticEnum<ELinearConstraintMotion>()->GetNameStringByValue(Profile.LinearLimit.XMotion));
	Joint->SetNumberField(TEXT("linear_limit"), Profile.LinearLimit.Limit);
	Joint->SetBoolField(TEXT("soft_limit"), Profile.LinearLimit.bSoftConstraint);
	Joint->SetNumberField(TEXT("stiffness"), Profile.LinearLimit.Stiffness);
	Joint->SetNumberField(TEXT("damping"), Profile.LinearLimit.Damping);
	Joint->SetStringField(TEXT("swing1_motion"), StaticEnum<EAngularConstraintMotion>()->GetNameStringByValue(Profile.ConeLimit.Swing1Motion));
	Joint->SetNumberField(TEXT("swing1_limit"), Profile.ConeLimit.Swing1LimitDegrees);
	Result->SetObjectField(TEXT("constraint"), Joint);
	Result->SetNumberField(TEXT("constraint_array_count"), Asset->Constraints.Num());
	return Result;
}
