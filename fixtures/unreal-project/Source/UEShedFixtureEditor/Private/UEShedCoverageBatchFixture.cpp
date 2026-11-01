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
