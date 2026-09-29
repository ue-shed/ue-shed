#include "UEShedPropertyBagFixture.h"
#include "UEShedNativeParserTypes.h"
#include "Dom/JsonObject.h"
#include "Misc/EngineVersionComparison.h"

void FillPropertyBagFixture(UUEShedNativeCoverageAsset* Asset, UObject* Reference)
{
	FInstancedPropertyBag& Bag = Asset->Parameters;
	Bag.Reset();
	TArray<FPropertyBagPropertyDesc> Descs = {
		{TEXT("Enabled"), EPropertyBagPropertyType::Bool},
		{TEXT("Count"), EPropertyBagPropertyType::Int32},
		{TEXT("Unsigned"), EPropertyBagPropertyType::UInt32},
		{TEXT("Weight"), EPropertyBagPropertyType::Double},
		{TEXT("Label"), EPropertyBagPropertyType::String},
		{TEXT("Offset"), EPropertyBagPropertyType::Struct, TBaseStructure<FVector>::Get()},
		{TEXT("Reference"), EPropertyBagPropertyType::Object, UObject::StaticClass()},
		{TEXT("Samples"), EPropertyBagContainerType::Array, EPropertyBagPropertyType::Float},
		{TEXT("Nested"), EPropertyBagPropertyType::Struct, FInstancedPropertyBag::StaticStruct()}
	};
	Descs[0].MetaData.Add({TEXT("Comment"), TEXT("caf\u00e9 / parameters")});
	Descs[0].MetaData.Add({TEXT("Empty"), TEXT("")});
#if !UE_VERSION_OLDER_THAN(5, 8, 0)
	Descs.Add({TEXT("Lookup"), EPropertyBagContainerType::Map, EPropertyBagPropertyType::Int32, nullptr, CPF_Edit, EPropertyBagPropertyType::Name});
#endif
	Bag.AddProperties(Descs);
	check(Bag.SetValueBool(TEXT("Enabled"), true) == EPropertyBagResult::Success);
	check(Bag.SetValueInt32(TEXT("Count"), -17) == EPropertyBagResult::Success);
	check(Bag.SetValueUInt32(TEXT("Unsigned"), MAX_uint32) == EPropertyBagResult::Success);
	check(Bag.SetValueDouble(TEXT("Weight"), 123456789.12345679) == EPropertyBagResult::Success);
	check(Bag.SetValueString(TEXT("Label"), TEXT("caf\u00e9 / \u4fdd\u5b58")) == EPropertyBagResult::Success);
	const FVector Offset(1.25, -2.5, 3.75);
	check(Bag.SetValueStruct(TEXT("Offset"), FConstStructView::Make(Offset)) == EPropertyBagResult::Success);
	check(Bag.SetValueObject(TEXT("Reference"), Reference) == EPropertyBagResult::Success);
	auto Samples = Bag.GetMutableArrayRef(TEXT("Samples")).GetValue();
	Samples.AddValues(3);
	Samples.SetValueFloat(0, -1.25f); Samples.SetValueFloat(1, 0.f); Samples.SetValueFloat(2, 9.5f);
	FInstancedPropertyBag Nested;
	Nested.AddProperty(TEXT("Message"), EPropertyBagPropertyType::String);
	Nested.SetValueString(TEXT("Message"), TEXT("nested value"));
	check(Bag.SetValueStruct(TEXT("Nested"), FConstStructView::Make(Nested)) == EPropertyBagResult::Success);
#if !UE_VERSION_OLDER_THAN(5, 8, 0)
	const FPropertyBagPropertyDesc* Lookup = Bag.FindPropertyDescByName(TEXT("Lookup"));
	const FMapProperty* MapProperty = CastFieldChecked<FMapProperty>(Lookup->CachedProperty);
	FScriptMapHelper MapValues(MapProperty, MapProperty->ContainerPtrToValuePtr<void>(Bag.GetMutableValue().GetMemory()));
	const int32 Entry = MapValues.AddDefaultValue_Invalid_NeedsRehash();
	CastFieldChecked<FNameProperty>(MapProperty->KeyProp)->SetPropertyValue(MapValues.GetKeyPtr(Entry), TEXT("primary"));
	CastFieldChecked<FIntProperty>(MapProperty->ValueProp)->SetPropertyValue(MapValues.GetValuePtr(Entry), -9);
	MapValues.Rehash();
#endif
	Asset->EmptyParameters.Reset();
	Asset->ParameterBags = {Bag, Asset->EmptyParameters};
	Asset->BagInstance.InitializeAs<FInstancedPropertyBag>(Bag);
}

TSharedRef<FJsonObject> PropertyBagFixtureEvidence(const UUEShedNativeCoverageAsset* Asset)
{
	const FInstancedPropertyBag& Bag = Asset->Parameters;
	auto Result = MakeShared<FJsonObject>();
	auto Values = MakeShared<FJsonObject>();
	Values->SetBoolField(TEXT("Enabled"), Bag.GetValueBool(TEXT("Enabled")).GetValue());
	Values->SetNumberField(TEXT("Count"), Bag.GetValueInt32(TEXT("Count")).GetValue());
	Values->SetNumberField(TEXT("Unsigned"), Bag.GetValueUInt32(TEXT("Unsigned")).GetValue());
	Values->SetNumberField(TEXT("Weight"), Bag.GetValueDouble(TEXT("Weight")).GetValue());
	Values->SetStringField(TEXT("Label"), Bag.GetValueString(TEXT("Label")).GetValue());
	Values->SetStringField(TEXT("Reference"), Bag.GetValueObject(TEXT("Reference")).GetValue()->GetPathName());
	const FVector& Offset = *Bag.GetValueStruct<FVector>(TEXT("Offset")).GetValue();
	Values->SetArrayField(TEXT("Offset"), {MakeShared<FJsonValueNumber>(Offset.X), MakeShared<FJsonValueNumber>(Offset.Y), MakeShared<FJsonValueNumber>(Offset.Z)});
	const auto Samples = Bag.GetArrayRef(TEXT("Samples")).GetValue();
	TArray<TSharedPtr<FJsonValue>> SampleValues;
	for (int32 Index = 0; Index < Samples.Num(); ++Index) SampleValues.Add(MakeShared<FJsonValueNumber>(Samples.GetValueFloat(Index).GetValue()));
	Values->SetArrayField(TEXT("Samples"), SampleValues);
	const auto* Nested = Bag.GetValueStruct<FInstancedPropertyBag>(TEXT("Nested")).GetValue();
	Values->SetStringField(TEXT("NestedMessage"), Nested->GetValueString(TEXT("Message")).GetValue());
#if !UE_VERSION_OLDER_THAN(5, 8, 0)
	const FPropertyBagPropertyDesc* Lookup = Bag.FindPropertyDescByName(TEXT("Lookup"));
	const FMapProperty* MapProperty = CastFieldChecked<FMapProperty>(Lookup->CachedProperty);
	FScriptMapHelper MapValues(MapProperty, MapProperty->ContainerPtrToValuePtr<void>(Bag.GetValue().GetMemory()));
	auto Entries = MakeShared<FJsonObject>();
	for (int32 Index = 0; Index < MapValues.GetMaxIndex(); ++Index) if (MapValues.IsValidIndex(Index))
	{
		Entries->SetNumberField(CastFieldChecked<FNameProperty>(MapProperty->KeyProp)->GetPropertyValue(MapValues.GetKeyPtr(Index)).ToString(), CastFieldChecked<FIntProperty>(MapProperty->ValueProp)->GetPropertyValue(MapValues.GetValuePtr(Index)));
	}
	Values->SetObjectField(TEXT("Lookup"), Entries);
#endif
	Result->SetObjectField(TEXT("values"), Values);
	TArray<TSharedPtr<FJsonValue>> Descriptors;
	for (const FPropertyBagPropertyDesc& Desc : Bag.GetPropertyBagStruct()->GetPropertyDescs())
	{
		auto Entry = MakeShared<FJsonObject>();
		Entry->SetStringField(TEXT("name"), Desc.Name.ToString());
		Entry->SetStringField(TEXT("id"), Desc.ID.ToString(EGuidFormats::Digits).ToLower());
		Entry->SetStringField(TEXT("type"), StaticEnum<EPropertyBagPropertyType>()->GetNameStringByValue(int64(Desc.ValueType)).ToLower());
		Entry->SetStringField(TEXT("type_object"), Desc.ValueTypeObject ? Desc.ValueTypeObject->GetPathName() : TEXT(""));
		TArray<TSharedPtr<FJsonValue>> Containers;
		for (uint32 Index = 0; Index < Desc.ContainerTypes.Num(); ++Index)
		{
			Containers.Add(MakeShared<FJsonValueString>(StaticEnum<EPropertyBagContainerType>()->GetNameStringByValue(int64(Desc.ContainerTypes[Index])).ToLower()));
		}
		Entry->SetArrayField(TEXT("containers"), Containers);
#if !UE_VERSION_OLDER_THAN(5, 8, 0)
		Entry->SetStringField(TEXT("flags"), LexToString(Desc.PropertyFlags));
		Entry->SetStringField(TEXT("key_type"), StaticEnum<EPropertyBagPropertyType>()->GetNameStringByValue(int64(Desc.KeyType)).ToLower());
		Entry->SetStringField(TEXT("key_type_object"), Desc.KeyTypeObject ? Desc.KeyTypeObject->GetPathName() : TEXT(""));
#endif
		auto Meta = MakeShared<FJsonObject>();
		for (const auto& Pair : Desc.MetaData) Meta->SetStringField(Pair.Key.ToString(), Pair.Value);
		Entry->SetObjectField(TEXT("metadata"), Meta);
		Descriptors.Add(MakeShared<FJsonValueObject>(Entry));
	}
	Result->SetArrayField(TEXT("descriptors"), Descriptors);
	return Result;
}
