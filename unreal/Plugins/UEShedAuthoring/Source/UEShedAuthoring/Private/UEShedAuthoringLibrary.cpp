#include "UEShedAuthoringLibrary.h"

#include "AssetRegistry/ARFilter.h"
#include "AssetRegistry/IAssetRegistry.h"
#include "Dom/JsonObject.h"
#include "Dom/JsonValue.h"
#include "DataTableEditorUtils.h"
#include "Engine/CompositeDataTable.h"
#include "Engine/DataTable.h"
#include "HAL/PlatformProcess.h"
#include "Misc/App.h"
#include "Misc/PackageName.h"
#include "ScopedTransaction.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"
#include "UObject/SavePackage.h"
#include "UObject/SoftObjectPtr.h"
#include "UObject/UnrealType.h"

namespace
{
uint32 RotateRight(uint32 Value, uint32 Bits)
{
	return (Value >> Bits) | (Value << (32 - Bits));
}

FString Sha256Hex(const uint8* Data, int32 Size)
{
	static constexpr uint32 Constants[64] = {
		0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
		0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
		0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
		0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
		0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
		0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
		0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
		0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
		0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
		0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
		0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
	};
	uint32 State[8] = {
		0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
		0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
	};
	TArray<uint8> Message;
	Message.Append(Data, Size);
	Message.Add(0x80);
	while (Message.Num() % 64 != 56) Message.Add(0);
	const uint64 BitLength = static_cast<uint64>(Size) * 8;
	for (int32 Shift = 56; Shift >= 0; Shift -= 8)
	{
		Message.Add(static_cast<uint8>(BitLength >> Shift));
	}
	for (int32 Offset = 0; Offset < Message.Num(); Offset += 64)
	{
		uint32 Words[64];
		for (int32 Index = 0; Index < 16; ++Index)
		{
			const uint8* Source = Message.GetData() + Offset + Index * 4;
			Words[Index] = static_cast<uint32>(Source[0]) << 24
				| static_cast<uint32>(Source[1]) << 16
				| static_cast<uint32>(Source[2]) << 8
				| static_cast<uint32>(Source[3]);
		}
		for (int32 Index = 16; Index < 64; ++Index)
		{
			const uint32 S0 = RotateRight(Words[Index - 15], 7)
				^ RotateRight(Words[Index - 15], 18) ^ (Words[Index - 15] >> 3);
			const uint32 S1 = RotateRight(Words[Index - 2], 17)
				^ RotateRight(Words[Index - 2], 19) ^ (Words[Index - 2] >> 10);
			Words[Index] = Words[Index - 16] + S0 + Words[Index - 7] + S1;
		}
		uint32 A = State[0], B = State[1], C = State[2], D = State[3];
		uint32 E = State[4], F = State[5], G = State[6], H = State[7];
		for (int32 Index = 0; Index < 64; ++Index)
		{
			const uint32 S1 = RotateRight(E, 6) ^ RotateRight(E, 11) ^ RotateRight(E, 25);
			const uint32 Choice = (E & F) ^ (~E & G);
			const uint32 Temp1 = H + S1 + Choice + Constants[Index] + Words[Index];
			const uint32 S0 = RotateRight(A, 2) ^ RotateRight(A, 13) ^ RotateRight(A, 22);
			const uint32 Majority = (A & B) ^ (A & C) ^ (B & C);
			const uint32 Temp2 = S0 + Majority;
			H = G; G = F; F = E; E = D + Temp1;
			D = C; C = B; B = A; A = Temp1 + Temp2;
		}
		State[0] += A; State[1] += B; State[2] += C; State[3] += D;
		State[4] += E; State[5] += F; State[6] += G; State[7] += H;
	}
	uint8 Digest[32];
	for (int32 Index = 0; Index < 8; ++Index)
	{
		Digest[Index * 4] = static_cast<uint8>(State[Index] >> 24);
		Digest[Index * 4 + 1] = static_cast<uint8>(State[Index] >> 16);
		Digest[Index * 4 + 2] = static_cast<uint8>(State[Index] >> 8);
		Digest[Index * 4 + 3] = static_cast<uint8>(State[Index]);
	}
	return BytesToHex(Digest, UE_ARRAY_COUNT(Digest)).ToLower();
}

TSharedRef<FJsonObject> ValueObject(const TCHAR* Kind)
{
	const TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
	Result->SetStringField(TEXT("kind"), Kind);
	return Result;
}

TSharedRef<FJsonObject> DescribePropertyType(const FProperty* Property);

TSharedRef<FJsonObject> DescribeEnum(const UEnum* Enum)
{
	const TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
	Result->SetStringField(TEXT("kind"), TEXT("enum"));
	Result->SetStringField(TEXT("enumPath"), Enum->GetPathName());
	TArray<TSharedPtr<FJsonValue>> Options;
	const int32 Count = Enum->NumEnums() - (Enum->ContainsExistingMax() ? 1 : 0);
	for (int32 Index = 0; Index < Count; ++Index)
	{
		if (Enum->HasMetaData(TEXT("Hidden"), Index)
			|| Enum->HasMetaData(TEXT("Spacer"), Index))
		{
			continue;
		}
		const TSharedRef<FJsonObject> Option = MakeShared<FJsonObject>();
		Option->SetStringField(TEXT("name"), Enum->GetNameByIndex(Index).ToString());
		Option->SetStringField(
			TEXT("displayName"), Enum->GetDisplayNameTextByIndex(Index).ToString());
		Options.Add(MakeShared<FJsonValueObject>(Option));
	}
	Result->SetArrayField(TEXT("options"), Options);
	return Result;
}

void AddStringMetadata(
	const TSharedRef<FJsonObject>& Annotations,
	const FProperty* Property,
	const TCHAR* MetadataName,
	const TCHAR* AnnotationName)
{
	if (Property->HasMetaData(MetadataName))
	{
		Annotations->SetStringField(AnnotationName, Property->GetMetaData(MetadataName));
	}
}

TSharedRef<FJsonObject> DescribeField(const FProperty* Property)
{
	const bool bReadOnly = Property->HasAnyPropertyFlags(CPF_EditConst);
	const TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
	Result->SetStringField(TEXT("id"), TEXT("field:") + Property->GetAuthoredName());
	Result->SetStringField(TEXT("name"), Property->GetAuthoredName());
	Result->SetStringField(TEXT("typeName"), Property->GetClass()->GetName());
	Result->SetObjectField(TEXT("type"), DescribePropertyType(Property));
	Result->SetStringField(TEXT("presence"), TEXT("required"));

	const TSharedRef<FJsonObject> Editability = MakeShared<FJsonObject>();
	Editability->SetStringField(TEXT("kind"), bReadOnly ? TEXT("read_only") : TEXT("editable"));
	if (bReadOnly)
	{
		Editability->SetStringField(TEXT("reason"), TEXT("Unreal marks this property EditConst."));
	}
	Result->SetObjectField(TEXT("editability"), Editability);

	const TSharedRef<FJsonObject> Annotations = MakeShared<FJsonObject>();
	Annotations->SetBoolField(
		TEXT("deprecated"), Property->HasAnyPropertyFlags(CPF_Deprecated));
	Annotations->SetBoolField(TEXT("readOnly"), bReadOnly);
	Annotations->SetStringField(TEXT("displayName"), Property->GetDisplayNameText().ToString());
	const FString Description = Property->GetToolTipText().ToString();
	if (!Description.IsEmpty())
	{
		Annotations->SetStringField(TEXT("description"), Description);
	}
	AddStringMetadata(Annotations, Property, TEXT("ClampMin"), TEXT("clampMin"));
	AddStringMetadata(Annotations, Property, TEXT("ClampMax"), TEXT("clampMax"));
	AddStringMetadata(Annotations, Property, TEXT("Delta"), TEXT("step"));
	AddStringMetadata(Annotations, Property, TEXT("Units"), TEXT("unit"));
	if (Property->HasMetaData(TEXT("RowType")))
	{
		const TSharedRef<FJsonObject> RowReference = MakeShared<FJsonObject>();
		const FString RowType = Property->GetMetaData(TEXT("RowType"));
		if (RowType.StartsWith(TEXT("/")))
		{
			RowReference->SetStringField(TEXT("status"), TEXT("known"));
			RowReference->SetStringField(TEXT("tableObjectPath"), RowType);
		}
		else
		{
			RowReference->SetStringField(TEXT("status"), TEXT("unknown"));
		}
		Annotations->SetObjectField(TEXT("rowReference"), RowReference);
	}
	Result->SetObjectField(TEXT("annotations"), Annotations);

	const TSharedRef<FJsonObject> DefaultValue = MakeShared<FJsonObject>();
	DefaultValue->SetStringField(TEXT("status"), TEXT("unknown"));
	Result->SetObjectField(TEXT("defaultValue"), DefaultValue);
	return Result;
}

TSharedRef<FJsonObject> DescribePropertyType(const FProperty* Property)
{
	if (const FEnumProperty* Enum = CastField<FEnumProperty>(Property))
	{
		return DescribeEnum(Enum->GetEnum());
	}
	if (const FByteProperty* Byte = CastField<FByteProperty>(Property); Byte && Byte->Enum)
	{
		return DescribeEnum(Byte->Enum);
	}
	if (const FArrayProperty* Array = CastField<FArrayProperty>(Property))
	{
		const TSharedRef<FJsonObject> Result = ValueObject(TEXT("array"));
		Result->SetObjectField(TEXT("element"), DescribePropertyType(Array->Inner));
		return Result;
	}
	if (const FSetProperty* Set = CastField<FSetProperty>(Property))
	{
		const TSharedRef<FJsonObject> Result = ValueObject(TEXT("set"));
		Result->SetObjectField(TEXT("element"), DescribePropertyType(Set->ElementProp));
		return Result;
	}
	if (const FMapProperty* Map = CastField<FMapProperty>(Property))
	{
		const TSharedRef<FJsonObject> Result = ValueObject(TEXT("map"));
		Result->SetObjectField(TEXT("key"), DescribePropertyType(Map->KeyProp));
		Result->SetObjectField(TEXT("value"), DescribePropertyType(Map->ValueProp));
		return Result;
	}
	if (const FSoftObjectProperty* SoftObject = CastField<FSoftObjectProperty>(Property))
	{
		const TSharedRef<FJsonObject> Result = ValueObject(TEXT("reference"));
		Result->SetStringField(TEXT("valueKind"), TEXT("soft_object_path"));
		const TSharedRef<FJsonObject> Target = MakeShared<FJsonObject>();
		if (SoftObject->PropertyClass)
		{
			Target->SetStringField(TEXT("status"), TEXT("known"));
			Target->SetStringField(TEXT("classPath"), SoftObject->PropertyClass->GetPathName());
		}
		else
		{
			Target->SetStringField(TEXT("status"), TEXT("unknown"));
		}
		Result->SetObjectField(TEXT("target"), Target);
		return Result;
	}
	if (const FObjectPropertyBase* Object = CastField<FObjectPropertyBase>(Property))
	{
		const TSharedRef<FJsonObject> Result = ValueObject(TEXT("reference"));
		Result->SetStringField(TEXT("valueKind"), TEXT("object_ref"));
		const TSharedRef<FJsonObject> Target = MakeShared<FJsonObject>();
		if (Object->PropertyClass)
		{
			Target->SetStringField(TEXT("status"), TEXT("known"));
			Target->SetStringField(TEXT("classPath"), Object->PropertyClass->GetPathName());
		}
		else
		{
			Target->SetStringField(TEXT("status"), TEXT("unknown"));
		}
		Result->SetObjectField(TEXT("target"), Target);
		return Result;
	}
	if (const FStructProperty* Struct = CastField<FStructProperty>(Property))
	{
		if (Struct->Struct == FDataTableRowHandle::StaticStruct())
		{
			return ValueObject(TEXT("row_reference"));
		}
		if (Struct->Struct == TBaseStructure<FVector>::Get())
		{
			return ValueObject(TEXT("vector"));
		}
		const TSharedRef<FJsonObject> Result = ValueObject(TEXT("struct"));
		Result->SetStringField(TEXT("structPath"), Struct->Struct->GetPathName());
		TArray<TSharedPtr<FJsonValue>> Fields;
		for (TFieldIterator<FProperty> It(Struct->Struct); It; ++It)
		{
			Fields.Add(MakeShared<FJsonValueObject>(DescribeField(*It)));
		}
		Result->SetArrayField(TEXT("fields"), Fields);
		return Result;
	}

	const TSharedRef<FJsonObject> Result = ValueObject(TEXT("scalar"));
	if (Property->IsA<FBoolProperty>()) Result->SetStringField(TEXT("valueKind"), TEXT("bool"));
	else if (Property->IsA<FDoubleProperty>()) Result->SetStringField(TEXT("valueKind"), TEXT("double"));
	else if (Property->IsA<FFloatProperty>()) Result->SetStringField(TEXT("valueKind"), TEXT("float"));
	else if (Property->IsA<FNameProperty>()) Result->SetStringField(TEXT("valueKind"), TEXT("name"));
	else if (Property->IsA<FStrProperty>()) Result->SetStringField(TEXT("valueKind"), TEXT("string"));
	else if (Property->IsA<FTextProperty>()) Result->SetStringField(TEXT("valueKind"), TEXT("text"));
	else if (const FNumericProperty* Number = CastField<FNumericProperty>(Property))
	{
		const bool bUnsigned = Property->IsA<FByteProperty>()
			|| Property->IsA<FUInt16Property>()
			|| Property->IsA<FUInt32Property>()
			|| Property->IsA<FUInt64Property>();
		Result->SetStringField(TEXT("valueKind"), bUnsigned ? TEXT("uint") : TEXT("int"));
	}
	else
	{
		Result->SetStringField(TEXT("kind"), TEXT("unsupported"));
		Result->SetStringField(TEXT("reason"), TEXT("No normalized authoring type is available."));
		Result->SetStringField(TEXT("typeName"), Property->GetClass()->GetName());
	}
	return Result;
}

TSharedPtr<FJsonValue> SerializePropertyValue(
	const FProperty* Property, const void* Value, bool& bPartial);

TSharedPtr<FJsonValue> SerializeField(const FProperty* Property, const void* Container, bool& bPartial)
{
	const TSharedRef<FJsonObject> Field = MakeShared<FJsonObject>();
	Field->SetStringField(TEXT("name"), Property->GetName());
	Field->SetStringField(TEXT("typeName"), Property->GetClass()->GetName());
	Field->SetField(TEXT("value"), SerializePropertyValue(
		Property, Property->ContainerPtrToValuePtr<void>(Container), bPartial));
	return MakeShared<FJsonValueObject>(Field);
}

TSharedPtr<FJsonValue> SerializePropertyValue(
	const FProperty* Property, const void* Value, bool& bPartial)
{
	if (const FBoolProperty* Bool = CastField<FBoolProperty>(Property))
	{
		const TSharedRef<FJsonObject> Result = ValueObject(TEXT("bool"));
		Result->SetBoolField(TEXT("value"), Bool->GetPropertyValue(Value));
		return MakeShared<FJsonValueObject>(Result);
	}
	if (const FEnumProperty* Enum = CastField<FEnumProperty>(Property))
	{
		const int64 Raw = Enum->GetUnderlyingProperty()->GetSignedIntPropertyValue(Value);
		const TSharedRef<FJsonObject> Result = ValueObject(TEXT("enum"));
		Result->SetStringField(TEXT("value"), Enum->GetEnum()->GetNameByValue(Raw).ToString());
		return MakeShared<FJsonValueObject>(Result);
	}
	if (const FByteProperty* Byte = CastField<FByteProperty>(Property); Byte && Byte->Enum)
	{
		const TSharedRef<FJsonObject> Result = ValueObject(TEXT("enum"));
		Result->SetStringField(
			TEXT("value"), Byte->Enum->GetNameByValue(Byte->GetPropertyValue(Value)).ToString());
		return MakeShared<FJsonValueObject>(Result);
	}
	if (const FNumericProperty* Number = CastField<FNumericProperty>(Property))
	{
		if (Number->IsInteger())
		{
			const bool bUnsigned = Property->IsA<FByteProperty>()
				|| Property->IsA<FUInt16Property>()
				|| Property->IsA<FUInt32Property>()
				|| Property->IsA<FUInt64Property>();
			const TSharedRef<FJsonObject> Result = ValueObject(bUnsigned ? TEXT("uint") : TEXT("int"));
			Result->SetStringField(TEXT("value"), bUnsigned
				? LexToString(Number->GetUnsignedIntPropertyValue(Value))
				: LexToString(Number->GetSignedIntPropertyValue(Value)));
			return MakeShared<FJsonValueObject>(Result);
		}
		const double Raw = Number->GetFloatingPointPropertyValue(Value);
		const TSharedRef<FJsonObject> Result = ValueObject(
			Property->IsA<FDoubleProperty>() ? TEXT("double") : TEXT("float"));
		if (FMath::IsNaN(Raw))
		{
			Result->SetStringField(TEXT("value"), TEXT("nan"));
		}
		else if (!FMath::IsFinite(Raw))
		{
			Result->SetStringField(TEXT("value"), Raw > 0 ? TEXT("infinity") : TEXT("-infinity"));
		}
		else
		{
			Result->SetNumberField(TEXT("value"), Raw);
		}
		return MakeShared<FJsonValueObject>(Result);
	}
	if (const FNameProperty* Name = CastField<FNameProperty>(Property))
	{
		const TSharedRef<FJsonObject> Result = ValueObject(TEXT("name"));
		Result->SetStringField(TEXT("value"), Name->GetPropertyValue(Value).ToString());
		return MakeShared<FJsonValueObject>(Result);
	}
	if (const FStrProperty* String = CastField<FStrProperty>(Property))
	{
		const TSharedRef<FJsonObject> Result = ValueObject(TEXT("string"));
		Result->SetStringField(TEXT("value"), String->GetPropertyValue(Value));
		return MakeShared<FJsonValueObject>(Result);
	}
	if (const FTextProperty* Text = CastField<FTextProperty>(Property))
	{
		const TSharedRef<FJsonObject> Result = ValueObject(TEXT("text"));
		Result->SetStringField(TEXT("value"), Text->GetPropertyValue(Value).ToString());
		return MakeShared<FJsonValueObject>(Result);
	}
	if (const FSoftObjectProperty* SoftObject = CastField<FSoftObjectProperty>(Property))
	{
		const TSharedRef<FJsonObject> Result = ValueObject(TEXT("soft_object_path"));
		Result->SetStringField(
			TEXT("value"), SoftObject->GetPropertyValue(Value).ToSoftObjectPath().ToString());
		return MakeShared<FJsonValueObject>(Result);
	}
	if (const FObjectPropertyBase* Object = CastField<FObjectPropertyBase>(Property))
	{
		const TSharedRef<FJsonObject> Result = ValueObject(TEXT("object_ref"));
		if (const UObject* Referenced = Object->GetObjectPropertyValue(Value))
		{
			Result->SetStringField(TEXT("value"), Referenced->GetPathName());
		}
		else
		{
			Result->SetField(TEXT("value"), MakeShared<FJsonValueNull>());
		}
		return MakeShared<FJsonValueObject>(Result);
	}
	if (const FStructProperty* Struct = CastField<FStructProperty>(Property))
	{
		if (Struct->Struct == FDataTableRowHandle::StaticStruct())
		{
			const FDataTableRowHandle& Handle = *static_cast<const FDataTableRowHandle*>(Value);
			const TSharedRef<FJsonObject> Result = ValueObject(TEXT("row_reference"));
			if (Handle.DataTable)
			{
				Result->SetStringField(TEXT("tableObjectPath"), Handle.DataTable->GetPathName());
			}
			else
			{
				Result->SetField(TEXT("tableObjectPath"), MakeShared<FJsonValueNull>());
			}
			Result->SetStringField(TEXT("rowName"), Handle.RowName.ToString());
			return MakeShared<FJsonValueObject>(Result);
		}
		if (Struct->Struct == TBaseStructure<FVector>::Get())
		{
			const FVector& Vector = *static_cast<const FVector*>(Value);
			const TSharedRef<FJsonObject> Result = ValueObject(TEXT("vector"));
			Result->SetNumberField(TEXT("x"), Vector.X);
			Result->SetNumberField(TEXT("y"), Vector.Y);
			Result->SetNumberField(TEXT("z"), Vector.Z);
			return MakeShared<FJsonValueObject>(Result);
		}
		const TSharedRef<FJsonObject> Result = ValueObject(TEXT("struct"));
		TArray<TSharedPtr<FJsonValue>> Fields;
		for (TFieldIterator<FProperty> It(Struct->Struct); It; ++It)
		{
			Fields.Add(SerializeField(*It, Value, bPartial));
		}
		Result->SetArrayField(TEXT("fields"), Fields);
		return MakeShared<FJsonValueObject>(Result);
	}
	if (const FArrayProperty* Array = CastField<FArrayProperty>(Property))
	{
		FScriptArrayHelper Helper(Array, Value);
		TArray<TSharedPtr<FJsonValue>> Values;
		for (int32 Index = 0; Index < Helper.Num(); ++Index)
		{
			Values.Add(SerializePropertyValue(Array->Inner, Helper.GetRawPtr(Index), bPartial));
		}
		const TSharedRef<FJsonObject> Result = ValueObject(TEXT("array"));
		Result->SetArrayField(TEXT("values"), Values);
		return MakeShared<FJsonValueObject>(Result);
	}
	if (const FSetProperty* Set = CastField<FSetProperty>(Property))
	{
		const FScriptSetHelper Helper(Set, Value);
		TArray<TSharedPtr<FJsonValue>> Values;
		for (int32 Index = 0; Index < Helper.GetMaxIndex(); ++Index)
		{
			if (Helper.IsValidIndex(Index))
			{
				Values.Add(SerializePropertyValue(Set->ElementProp, Helper.GetElementPtr(Index), bPartial));
			}
		}
		const TSharedRef<FJsonObject> Result = ValueObject(TEXT("set"));
		Result->SetArrayField(TEXT("values"), Values);
		return MakeShared<FJsonValueObject>(Result);
	}
	if (const FMapProperty* Map = CastField<FMapProperty>(Property))
	{
		FScriptMapHelper Helper(Map, Value);
		TArray<TSharedPtr<FJsonValue>> Entries;
		for (int32 Index = 0; Index < Helper.GetMaxIndex(); ++Index)
		{
			if (!Helper.IsValidIndex(Index))
			{
				continue;
			}
			const TSharedRef<FJsonObject> Entry = MakeShared<FJsonObject>();
			Entry->SetField(TEXT("key"), SerializePropertyValue(
				Map->KeyProp, Helper.GetKeyPtr(Index), bPartial));
			Entry->SetField(TEXT("value"), SerializePropertyValue(
				Map->ValueProp, Helper.GetValuePtr(Index), bPartial));
			Entries.Add(MakeShared<FJsonValueObject>(Entry));
		}
		const TSharedRef<FJsonObject> Result = ValueObject(TEXT("map"));
		Result->SetArrayField(TEXT("entries"), Entries);
		return MakeShared<FJsonValueObject>(Result);
	}

	bPartial = true;
	const TSharedRef<FJsonObject> Result = ValueObject(TEXT("unsupported"));
	Result->SetNumberField(TEXT("byteSize"), Property->GetSize());
	Result->SetStringField(TEXT("reason"), TEXT("unsupported type"));
	return MakeShared<FJsonValueObject>(Result);
}

FString SerializePrimitive(const TSharedPtr<FJsonValue>& Value)
{
	FString Result;
	const TSharedRef<TJsonWriter<TCHAR, TCondensedJsonPrintPolicy<TCHAR>>> Writer =
		TJsonWriterFactory<TCHAR, TCondensedJsonPrintPolicy<TCHAR>>::Create(&Result);
	FJsonSerializer::Serialize(Value, FString(), Writer);
	return Result;
}

FString CanonicalJson(const TSharedPtr<FJsonValue>& Value)
{
	if (!Value.IsValid() || Value->Type == EJson::Null)
	{
		return TEXT("null");
	}
	if (Value->Type == EJson::Array)
	{
		TArray<FString> Parts;
		for (const TSharedPtr<FJsonValue>& Item : Value->AsArray())
		{
			Parts.Add(CanonicalJson(Item));
		}
		return FString::Printf(TEXT("[%s]"), *FString::Join(Parts, TEXT(",")));
	}
	if (Value->Type != EJson::Object)
	{
		return SerializePrimitive(Value);
	}

	const TSharedPtr<FJsonObject> Object = Value->AsObject();
	TArray<FString> Keys;
	Object->Values.GetKeys(Keys);
	Keys.Sort([](const FString& Left, const FString& Right)
	{
		return Left.Compare(Right, ESearchCase::CaseSensitive) < 0;
	});
	TArray<FString> Parts;
	for (const FString& Key : Keys)
	{
		TSharedPtr<FJsonValue> Field = Object->Values[Key];
		if (Key == TEXT("values") && Object->GetStringField(TEXT("kind")) == TEXT("set"))
		{
			TArray<FString> Values;
			for (const TSharedPtr<FJsonValue>& Item : Field->AsArray())
			{
				Values.Add(CanonicalJson(Item));
			}
			Values.Sort([](const FString& Left, const FString& Right)
			{
				return Left.Compare(Right, ESearchCase::CaseSensitive) < 0;
			});
			Parts.Add(SerializePrimitive(MakeShared<FJsonValueString>(Key))
				+ TEXT(":[") + FString::Join(Values, TEXT(",")) + TEXT("]"));
			continue;
		}
		if (Key == TEXT("entries") && Object->GetStringField(TEXT("kind")) == TEXT("map"))
		{
			TArray<FString> Entries;
			for (const TSharedPtr<FJsonValue>& Item : Field->AsArray())
			{
				Entries.Add(CanonicalJson(Item));
			}
			Entries.Sort([](const FString& Left, const FString& Right)
			{
				return Left.Compare(Right, ESearchCase::CaseSensitive) < 0;
			});
			Parts.Add(SerializePrimitive(MakeShared<FJsonValueString>(Key))
				+ TEXT(":[") + FString::Join(Entries, TEXT(",")) + TEXT("]"));
			continue;
		}
		Parts.Add(SerializePrimitive(MakeShared<FJsonValueString>(Key))
			+ TEXT(":") + CanonicalJson(Field));
	}
	return TEXT("{") + FString::Join(Parts, TEXT(",")) + TEXT("}");
}

bool AssignPropertyValue(
	const FProperty* Property, void* Value, const TSharedPtr<FJsonObject>& Input, FString& Error)
{
	FString Kind;
	if (!Input.IsValid() || !Input->TryGetStringField(TEXT("kind"), Kind))
	{
		Error = TEXT("value kind is missing");
		return false;
	}
	if (const FBoolProperty* Bool = CastField<FBoolProperty>(Property))
	{
		bool Parsed;
		if (Kind != TEXT("bool") || !Input->TryGetBoolField(TEXT("value"), Parsed))
		{
			Error = TEXT("expected bool value");
			return false;
		}
		Bool->SetPropertyValue(Value, Parsed);
		return true;
	}
	if (const FEnumProperty* Enum = CastField<FEnumProperty>(Property))
	{
		FString Parsed;
		if (Kind != TEXT("enum") || !Input->TryGetStringField(TEXT("value"), Parsed))
		{
			Error = TEXT("expected enum value");
			return false;
		}
		const int64 Raw = Enum->GetEnum()->GetValueByNameString(Parsed);
		if (Raw == INDEX_NONE)
		{
			Error = FString::Printf(TEXT("unknown enum value %s"), *Parsed);
			return false;
		}
		Enum->GetUnderlyingProperty()->SetIntPropertyValue(Value, Raw);
		return true;
	}
	if (const FByteProperty* Byte = CastField<FByteProperty>(Property); Byte && Byte->Enum)
	{
		FString Parsed;
		if (Kind != TEXT("enum") || !Input->TryGetStringField(TEXT("value"), Parsed))
		{
			Error = TEXT("expected enum value");
			return false;
		}
		const int64 Raw = Byte->Enum->GetValueByNameString(Parsed);
		if (Raw == INDEX_NONE || Raw > MAX_uint8)
		{
			Error = FString::Printf(TEXT("unknown enum value %s"), *Parsed);
			return false;
		}
		Byte->SetPropertyValue(Value, static_cast<uint8>(Raw));
		return true;
	}
	if (const FNumericProperty* Number = CastField<FNumericProperty>(Property))
	{
		if (Number->IsInteger())
		{
			FString Parsed;
			if (!Input->TryGetStringField(TEXT("value"), Parsed))
			{
				Error = TEXT("expected integer string");
				return false;
			}
			if (Kind == TEXT("uint"))
			{
				uint64 Raw;
				if (!LexTryParseString(Raw, *Parsed))
				{
					Error = TEXT("invalid unsigned integer");
					return false;
				}
				Number->SetIntPropertyValue(Value, Raw);
				return true;
			}
			int64 Raw;
			if (Kind != TEXT("int") || !LexTryParseString(Raw, *Parsed))
			{
				Error = TEXT("invalid signed integer");
				return false;
			}
			Number->SetIntPropertyValue(Value, Raw);
			return true;
		}
		double Raw;
		const TSharedPtr<FJsonValue> JsonValue = Input->TryGetField(TEXT("value"));
		if (!JsonValue.IsValid() || (Kind != TEXT("float") && Kind != TEXT("double")))
		{
			Error = TEXT("expected floating point value");
			return false;
		}
		if (JsonValue->Type == EJson::String)
		{
			const FString Special = JsonValue->AsString();
			Raw = Special == TEXT("nan") ? NAN
				: Special == TEXT("infinity") ? INFINITY
				: Special == TEXT("-infinity") ? -INFINITY : 0.0;
			if (Special != TEXT("nan") && Special != TEXT("infinity")
				&& Special != TEXT("-infinity"))
			{
				Error = TEXT("invalid special floating point value");
				return false;
			}
		}
		else
		{
			Raw = JsonValue->AsNumber();
		}
		Number->SetFloatingPointPropertyValue(Value, Raw);
		return true;
	}
	FString Text;
	if (const FNameProperty* Name = CastField<FNameProperty>(Property))
	{
		if (Kind != TEXT("name") || !Input->TryGetStringField(TEXT("value"), Text))
		{
			Error = TEXT("expected name value");
			return false;
		}
		Name->SetPropertyValue(Value, FName(Text));
		return true;
	}
	if (const FStrProperty* String = CastField<FStrProperty>(Property))
	{
		if (Kind != TEXT("string") || !Input->TryGetStringField(TEXT("value"), Text))
		{
			Error = TEXT("expected string value");
			return false;
		}
		String->SetPropertyValue(Value, Text);
		return true;
	}
	if (const FTextProperty* TextProperty = CastField<FTextProperty>(Property))
	{
		if (Kind != TEXT("text") || !Input->TryGetStringField(TEXT("value"), Text))
		{
			Error = TEXT("expected text value");
			return false;
		}
		TextProperty->SetPropertyValue(Value, FText::FromString(Text));
		return true;
	}
	if (const FSoftObjectProperty* Soft = CastField<FSoftObjectProperty>(Property))
	{
		if (Kind != TEXT("soft_object_path") || !Input->TryGetStringField(TEXT("value"), Text))
		{
			Error = TEXT("expected soft object path");
			return false;
		}
		Soft->SetPropertyValue(Value, FSoftObjectPtr(FSoftObjectPath(Text)));
		return true;
	}
	if (const FObjectPropertyBase* Object = CastField<FObjectPropertyBase>(Property))
	{
		if (Kind != TEXT("object_ref"))
		{
			Error = TEXT("expected object reference");
			return false;
		}
		const TSharedPtr<FJsonValue> JsonValue = Input->TryGetField(TEXT("value"));
		UObject* Referenced = nullptr;
		if (JsonValue.IsValid() && JsonValue->Type != EJson::Null)
		{
			Referenced = LoadObject<UObject>(nullptr, *JsonValue->AsString());
			if (!Referenced)
			{
				Error = FString::Printf(TEXT("object not found: %s"), *JsonValue->AsString());
				return false;
			}
		}
		Object->SetObjectPropertyValue(Value, Referenced);
		return true;
	}
	if (const FStructProperty* Struct = CastField<FStructProperty>(Property))
	{
		if (Struct->Struct == FDataTableRowHandle::StaticStruct()
			&& Kind == TEXT("row_reference"))
		{
			FDataTableRowHandle& Handle = *static_cast<FDataTableRowHandle*>(Value);
			const TSharedPtr<FJsonValue> TableValue = Input->TryGetField(TEXT("tableObjectPath"));
			Handle.DataTable = nullptr;
			if (TableValue.IsValid() && TableValue->Type != EJson::Null)
			{
				Handle.DataTable = LoadObject<UDataTable>(nullptr, *TableValue->AsString());
				if (!Handle.DataTable)
				{
					Error = FString::Printf(
						TEXT("data table not found: %s"), *TableValue->AsString());
					return false;
				}
			}
			FString RowName;
			if (!Input->TryGetStringField(TEXT("rowName"), RowName))
			{
				Error = TEXT("row reference is missing rowName");
				return false;
			}
			Handle.RowName = FName(RowName);
			return true;
		}
		if (Struct->Struct == TBaseStructure<FVector>::Get() && Kind == TEXT("vector"))
		{
			FVector& Vector = *static_cast<FVector*>(Value);
			if (!Input->TryGetNumberField(TEXT("x"), Vector.X)
				|| !Input->TryGetNumberField(TEXT("y"), Vector.Y)
				|| !Input->TryGetNumberField(TEXT("z"), Vector.Z))
			{
				Error = TEXT("invalid vector value");
				return false;
			}
			return true;
		}
		if (Kind != TEXT("struct"))
		{
			Error = TEXT("expected struct value");
			return false;
		}
		for (const TSharedPtr<FJsonValue>& FieldValue : Input->GetArrayField(TEXT("fields")))
		{
			const TSharedPtr<FJsonObject> Field = FieldValue->AsObject();
			const FString FieldName = Field->GetStringField(TEXT("name"));
			FProperty* Child = Struct->Struct->FindPropertyByName(FName(FieldName));
			if (!Child || !AssignPropertyValue(Child, Child->ContainerPtrToValuePtr<void>(Value),
				Field->GetObjectField(TEXT("value")), Error))
			{
				if (!Child) Error = FString::Printf(TEXT("unknown struct field %s"), *FieldName);
				return false;
			}
		}
		return true;
	}
	if (const FArrayProperty* Array = CastField<FArrayProperty>(Property))
	{
		if (Kind != TEXT("array")) { Error = TEXT("expected array value"); return false; }
		const TArray<TSharedPtr<FJsonValue>>& Values = Input->GetArrayField(TEXT("values"));
		FScriptArrayHelper Helper(Array, Value);
		Helper.Resize(Values.Num());
		for (int32 Index = 0; Index < Values.Num(); ++Index)
		{
			if (!AssignPropertyValue(Array->Inner, Helper.GetRawPtr(Index),
				Values[Index]->AsObject(), Error)) return false;
		}
		return true;
	}
	if (const FSetProperty* Set = CastField<FSetProperty>(Property))
	{
		if (Kind != TEXT("set")) { Error = TEXT("expected set value"); return false; }
		FScriptSetHelper Helper(Set, Value);
		Helper.EmptyElements();
		for (const TSharedPtr<FJsonValue>& Item : Input->GetArrayField(TEXT("values")))
		{
			const int32 Index = Helper.AddDefaultValue_Invalid_NeedsRehash();
			if (!AssignPropertyValue(Set->ElementProp, Helper.GetElementPtr(Index),
				Item->AsObject(), Error)) return false;
		}
		Helper.Rehash();
		return true;
	}
	if (const FMapProperty* Map = CastField<FMapProperty>(Property))
	{
		if (Kind != TEXT("map")) { Error = TEXT("expected map value"); return false; }
		FScriptMapHelper Helper(Map, Value);
		Helper.EmptyValues();
		for (const TSharedPtr<FJsonValue>& Item : Input->GetArrayField(TEXT("entries")))
		{
			const int32 Index = Helper.AddDefaultValue_Invalid_NeedsRehash();
			const TSharedPtr<FJsonObject> Entry = Item->AsObject();
			if (!AssignPropertyValue(Map->KeyProp, Helper.GetKeyPtr(Index),
				Entry->GetObjectField(TEXT("key")), Error)
				|| !AssignPropertyValue(Map->ValueProp, Helper.GetValuePtr(Index),
					Entry->GetObjectField(TEXT("value")), Error)) return false;
		}
		Helper.Rehash();
		return true;
	}
	Error = FString::Printf(TEXT("unsupported property type %s"), *Property->GetClass()->GetName());
	return false;
}

TArray<FString> CompositeParents(const UDataTable* Table)
{
	TArray<FString> Result;
	const UCompositeDataTable* Composite = Cast<UCompositeDataTable>(Table);
	if (!Composite)
	{
		return Result;
	}
	const FArrayProperty* ParentProperty = FindFProperty<FArrayProperty>(
		Composite->GetClass(), TEXT("ParentTables"));
	if (!ParentProperty)
	{
		return Result;
	}
	const void* Value = ParentProperty->ContainerPtrToValuePtr<void>(Composite);
	FScriptArrayHelper Helper(ParentProperty, Value);
	const FObjectPropertyBase* Inner = CastFieldChecked<FObjectPropertyBase>(ParentProperty->Inner);
	for (int32 Index = 0; Index < Helper.Num(); ++Index)
	{
		if (const UObject* Parent = Inner->GetObjectPropertyValue(Helper.GetRawPtr(Index)))
		{
			Result.Add(Parent->GetPathName());
		}
	}
	return Result;
}

FString JsonString(const TSharedRef<FJsonObject>& Object)
{
	FString Result;
	const TSharedRef<TJsonWriter<>> Writer = TJsonWriterFactory<>::Create(&Result);
	FJsonSerializer::Serialize(Object, Writer);
	return Result;
}

FString TableFingerprintFromJson(const TSharedPtr<FJsonObject>& TableJson);

TSharedRef<FJsonObject> BuildTableSnapshot(const UDataTable* Table)
{
	bool bPartial = false;
	TArray<TSharedPtr<FJsonValue>> Rows;
	for (const FName RowName : Table->GetRowNames())
	{
		const uint8* const* RowData = Table->GetRowMap().Find(RowName);
		if (!RowData) continue;
		const TSharedRef<FJsonObject> Row = MakeShared<FJsonObject>();
		Row->SetStringField(TEXT("id"), FString::Printf(TEXT("row:%s"), *RowName.ToString()));
		Row->SetStringField(TEXT("name"), RowName.ToString());
		TArray<TSharedPtr<FJsonValue>> Fields;
		for (TFieldIterator<FProperty> It(Table->GetRowStruct()); It; ++It)
		{
			Fields.Add(SerializeField(*It, *RowData, bPartial));
		}
		Row->SetArrayField(TEXT("fields"), Fields);
		Rows.Add(MakeShared<FJsonValueObject>(Row));
	}

	const TSharedRef<FJsonObject> Contract = MakeShared<FJsonObject>();
	Contract->SetStringField(TEXT("name"), TEXT("unreal-authoring"));
	const TSharedRef<FJsonObject> Version = MakeShared<FJsonObject>();
	Version->SetNumberField(TEXT("major"), 2);
	Version->SetNumberField(TEXT("minor"), 1);
	Contract->SetObjectField(TEXT("version"), Version);
	const TSharedRef<FJsonObject> Authority = MakeShared<FJsonObject>();
	Authority->SetStringField(TEXT("kind"), TEXT("live_editor"));
	Authority->SetStringField(TEXT("producerId"), FApp::GetSessionId().ToString());
	Authority->SetStringField(TEXT("sessionId"), LexToString(FPlatformProcess::GetCurrentProcessId()));
	const TSharedRef<FJsonObject> Producer = MakeShared<FJsonObject>();
	Producer->SetStringField(TEXT("name"), TEXT("UEShedAuthoring"));
	Producer->SetStringField(TEXT("version"), TEXT("1"));
	const TSharedRef<FJsonObject> TableJson = MakeShared<FJsonObject>();
	TableJson->SetStringField(TEXT("kind"), Table->IsA<UCompositeDataTable>()
		? TEXT("composite_data_table") : TEXT("data_table"));
	TableJson->SetStringField(TEXT("objectPath"), Table->GetPathName());
	TableJson->SetStringField(TEXT("packageName"), Table->GetOutermost()->GetName());
	TableJson->SetStringField(TEXT("rowStruct"), Table->GetRowStruct()->GetPathName());
	TArray<TSharedPtr<FJsonValue>> Parents;
	for (const FString& Parent : CompositeParents(Table))
	{
		Parents.Add(MakeShared<FJsonValueString>(Parent));
	}
	TableJson->SetArrayField(TEXT("parentTables"), Parents);
	TableJson->SetArrayField(TEXT("rows"), Rows);
	const TSharedRef<FJsonObject> Schema = MakeShared<FJsonObject>();
	Schema->SetStringField(TEXT("status"), TEXT("available"));
	Schema->SetStringField(TEXT("source"), TEXT("live_reflection"));
	TArray<TSharedPtr<FJsonValue>> SchemaFields;
	for (TFieldIterator<FProperty> It(Table->GetRowStruct()); It; ++It)
	{
		SchemaFields.Add(MakeShared<FJsonValueObject>(DescribeField(*It)));
	}
	Schema->SetArrayField(TEXT("fields"), SchemaFields);
	TableJson->SetObjectField(TEXT("schema"), Schema);
	const TSharedRef<FJsonObject> Fingerprint = MakeShared<FJsonObject>();
	Fingerprint->SetStringField(TEXT("status"), TEXT("available"));
	Fingerprint->SetStringField(TEXT("algorithm"), TEXT("sha256"));
	Fingerprint->SetNumberField(TEXT("version"), 1);
	Fingerprint->SetStringField(TEXT("value"), TableFingerprintFromJson(TableJson));
	const TSharedRef<FJsonObject> Root = MakeShared<FJsonObject>();
	Root->SetObjectField(TEXT("contract"), Contract);
	Root->SetObjectField(TEXT("authority"), Authority);
	Root->SetStringField(TEXT("completeness"), bPartial ? TEXT("partial") : TEXT("complete"));
	Root->SetObjectField(TEXT("fingerprint"), Fingerprint);
	Root->SetObjectField(TEXT("producer"), Producer);
	Root->SetObjectField(TEXT("table"), TableJson);
	Root->SetArrayField(TEXT("diagnostics"), {});
	return Root;
}

FString TableFingerprint(const UDataTable* Table)
{
	const TSharedPtr<FJsonObject> TableJson = BuildTableSnapshot(Table)->GetObjectField(TEXT("table"));
	return TableFingerprintFromJson(TableJson);
}

FString TableFingerprintFromJson(const TSharedPtr<FJsonObject>& TableJson)
{
	const TSharedRef<FJsonObject> Semantic = MakeShared<FJsonObject>();
	for (const FString& Field : { TEXT("kind"), TEXT("objectPath"), TEXT("rowStruct") })
	{
		Semantic->SetStringField(Field, TableJson->GetStringField(Field));
	}
	Semantic->SetArrayField(TEXT("parentTables"), TableJson->GetArrayField(TEXT("parentTables")));
	TArray<TSharedPtr<FJsonValue>> Rows;
	for (const TSharedPtr<FJsonValue>& RowValue : TableJson->GetArrayField(TEXT("rows")))
	{
		const TSharedPtr<FJsonObject> Source = RowValue->AsObject();
		const TSharedRef<FJsonObject> Row = MakeShared<FJsonObject>();
		Row->SetStringField(TEXT("name"), Source->GetStringField(TEXT("name")));
		Row->SetArrayField(TEXT("fields"), Source->GetArrayField(TEXT("fields")));
		Rows.Add(MakeShared<FJsonValueObject>(Row));
	}
	Semantic->SetArrayField(TEXT("rows"), Rows);
	const FString Canonical = CanonicalJson(MakeShared<FJsonValueObject>(Semantic));
	const FTCHARToUTF8 Bytes(*Canonical);
	return TEXT("sha256-v1:") + Sha256Hex(
		reinterpret_cast<const uint8*>(Bytes.Get()), Bytes.Length());
}

TSharedRef<FJsonObject> OperationContract(const TCHAR* Name)
{
	const TSharedRef<FJsonObject> Contract = MakeShared<FJsonObject>();
	Contract->SetStringField(TEXT("name"), Name);
	const TSharedRef<FJsonObject> Version = MakeShared<FJsonObject>();
	Version->SetNumberField(TEXT("major"), 1);
	Version->SetNumberField(TEXT("minor"), 1);
	Contract->SetObjectField(TEXT("version"), Version);
	return Contract;
}

bool HasContract(const TSharedPtr<FJsonObject>& Request, const TCHAR* Name)
{
	const TSharedPtr<FJsonObject>* Contract;
	FString ContractName;
	if (!Request->TryGetObjectField(TEXT("contract"), Contract)
		|| !(*Contract)->TryGetStringField(TEXT("name"), ContractName)
		|| ContractName != Name)
	{
		return false;
	}
	const TSharedPtr<FJsonObject>* Version;
	double Major;
	return (*Contract)->TryGetObjectField(TEXT("version"), Version)
		&& (*Version)->TryGetNumberField(TEXT("major"), Major) && Major == 1;
}

TSharedPtr<FJsonValue> OperationError(
	const FString& Code, const FString& Message, bool bRetrySafe,
	const FString& ObjectPath = FString(), const FString& CommandId = FString())
{
	const TSharedRef<FJsonObject> Error = MakeShared<FJsonObject>();
	Error->SetStringField(TEXT("code"), Code);
	Error->SetStringField(TEXT("message"), Message);
	Error->SetBoolField(TEXT("retrySafe"), bRetrySafe);
	if (!ObjectPath.IsEmpty()) Error->SetStringField(TEXT("objectPath"), ObjectPath);
	if (!CommandId.IsEmpty()) Error->SetStringField(TEXT("commandId"), CommandId);
	return MakeShared<FJsonValueObject>(Error);
}

struct FApplyCacheEntry
{
	FString RequestDigest;
	FString Result;
};

TMap<FString, FApplyCacheEntry> ApplyResultCache;
TArray<FString> ApplyResultOrder;
constexpr int32 MaxApplyResults = 128;

void CacheApplyResult(
	const FString& OperationId, const FString& RequestDigest, const FString& Result)
{
	if (!ApplyResultCache.Contains(OperationId)) ApplyResultOrder.Add(OperationId);
	ApplyResultCache.Add(OperationId, { RequestDigest, Result });
	while (ApplyResultOrder.Num() > MaxApplyResults)
	{
		ApplyResultCache.Remove(ApplyResultOrder[0]);
		ApplyResultOrder.RemoveAt(0);
	}
}

bool ApplyCommand(
	UDataTable* Table, const TSharedPtr<FJsonObject>& Command,
	TMap<FString, FName>& RowNames, FString& Error)
{
	const TSharedPtr<FJsonObject> Body = Command->GetObjectField(TEXT("body"));
	const FString Kind = Body->GetStringField(TEXT("kind"));
	if (Kind == TEXT("set_cell"))
	{
		const FString RowId = Body->GetStringField(TEXT("rowId"));
		const FName* RowName = RowNames.Find(RowId);
		uint8* const* RowData = RowName ? Table->GetRowMap().Find(*RowName) : nullptr;
		if (!RowData) { Error = FString::Printf(TEXT("unknown row %s"), *RowId); return false; }
		const FString FieldName = Body->GetStringField(TEXT("fieldName"));
		FProperty* Property = Table->GetRowStruct()->FindPropertyByName(FName(FieldName));
		if (!Property) { Error = FString::Printf(TEXT("unknown field %s"), *FieldName); return false; }
		bool bPartial = false;
		const TSharedPtr<FJsonValue> Current = SerializePropertyValue(
			Property, Property->ContainerPtrToValuePtr<void>(*RowData), bPartial);
		if (bPartial || CanonicalJson(Current) != CanonicalJson(Body->TryGetField(TEXT("oldValue"))))
		{
			Error = FString::Printf(TEXT("field %s no longer matches oldValue"), *FieldName);
			return false;
		}
		return AssignPropertyValue(Property, Property->ContainerPtrToValuePtr<void>(*RowData),
			Body->GetObjectField(TEXT("newValue")), Error);
	}
	if (Kind == TEXT("add_row"))
	{
		const TSharedPtr<FJsonObject> Row = Body->GetObjectField(TEXT("row"));
		const FString RowId = Row->GetStringField(TEXT("id"));
		const FName RowName(Row->GetStringField(TEXT("name")));
		if (RowNames.Contains(RowId) || Table->GetRowMap().Contains(RowName))
		{
			Error = TEXT("row identity or name already exists");
			return false;
		}
		const int32 AtIndex = Body->GetIntegerField(TEXT("atIndex"));
		if (AtIndex < 0 || AtIndex > Table->GetRowMap().Num())
		{
			Error = TEXT("add row index is out of range");
			return false;
		}
		uint8* RowData = FDataTableEditorUtils::AddRow(Table, RowName);
		if (!RowData) { Error = TEXT("Unreal rejected the new row"); return false; }
		for (const TSharedPtr<FJsonValue>& FieldValue : Row->GetArrayField(TEXT("fields")))
		{
			const TSharedPtr<FJsonObject> Field = FieldValue->AsObject();
			const FString FieldName = Field->GetStringField(TEXT("name"));
			FProperty* Property = Table->GetRowStruct()->FindPropertyByName(FName(FieldName));
			if (!Property || !AssignPropertyValue(Property,
				Property->ContainerPtrToValuePtr<void>(RowData),
				Field->GetObjectField(TEXT("value")), Error))
			{
				if (!Property) Error = FString::Printf(TEXT("unknown field %s"), *FieldName);
				return false;
			}
		}
		const int32 MoveBy = Table->GetRowMap().Num() - 1 - AtIndex;
		if (MoveBy > 0 && !FDataTableEditorUtils::MoveRow(
			Table, RowName, FDataTableEditorUtils::ERowMoveDirection::Up, MoveBy))
		{
			Error = TEXT("Unreal rejected the requested row position");
			return false;
		}
		RowNames.Add(RowId, RowName);
		return true;
	}
	if (Kind == TEXT("remove_row"))
	{
		const TSharedPtr<FJsonObject> Row = Body->GetObjectField(TEXT("row"));
		const FString RowId = Row->GetStringField(TEXT("id"));
		const FName* RowName = RowNames.Find(RowId);
		const int32 AtIndex = Body->GetIntegerField(TEXT("atIndex"));
		if (!RowName || !Table->GetRowNames().IsValidIndex(AtIndex)
			|| Table->GetRowNames()[AtIndex] != *RowName)
		{
			Error = TEXT("row moved or no longer exists before removal");
			return false;
		}
		if (!FDataTableEditorUtils::RemoveRow(Table, *RowName))
		{
			Error = TEXT("Unreal rejected row removal");
			return false;
		}
		RowNames.Remove(RowId);
		return true;
	}
	if (Kind == TEXT("rename_row"))
	{
		const FString RowId = Body->GetStringField(TEXT("rowId"));
		FName* Current = RowNames.Find(RowId);
		const FName OldName(Body->GetStringField(TEXT("oldName")));
		const FName NewName(Body->GetStringField(TEXT("newName")));
		if (!Current || *Current != OldName || Table->GetRowMap().Contains(NewName))
		{
			Error = TEXT("row name drift or duplicate target name");
			return false;
		}
		if (!FDataTableEditorUtils::RenameRow(Table, OldName, NewName))
		{
			Error = TEXT("Unreal rejected row rename");
			return false;
		}
		*Current = NewName;
		return true;
	}
	if (Kind == TEXT("reorder_rows"))
	{
		const TArray<TSharedPtr<FJsonValue>>& OldOrder = Body->GetArrayField(TEXT("oldOrder"));
		const TArray<TSharedPtr<FJsonValue>>& NewOrder = Body->GetArrayField(TEXT("newOrder"));
		if (OldOrder.Num() != RowNames.Num() || NewOrder.Num() != RowNames.Num())
		{
			Error = TEXT("reorder must contain every row identity");
			return false;
		}
		TMap<FName, FString> IdByName;
		for (const TPair<FString, FName>& Pair : RowNames) IdByName.Add(Pair.Value, Pair.Key);
		const TArray<FName> CurrentNames = Table->GetRowNames();
		for (int32 Index = 0; Index < CurrentNames.Num(); ++Index)
		{
			const FString* Id = IdByName.Find(CurrentNames[Index]);
			if (!Id || OldOrder[Index]->AsString() != *Id)
			{
				Error = TEXT("row order drifted before reorder");
				return false;
			}
		}
		TSet<FString> Requested;
		for (const TSharedPtr<FJsonValue>& IdValue : NewOrder)
		{
			const FString Id = IdValue->AsString();
			if (!RowNames.Contains(Id) || Requested.Contains(Id))
			{
				Error = TEXT("new row order is not a permutation");
				return false;
			}
			Requested.Add(Id);
		}
		for (int32 Target = 0; Target < NewOrder.Num(); ++Target)
		{
			const FName RowName = RowNames[NewOrder[Target]->AsString()];
			const int32 CurrentIndex = Table->GetRowNames().IndexOfByKey(RowName);
			if (CurrentIndex > Target && !FDataTableEditorUtils::MoveRow(
				Table, RowName, FDataTableEditorUtils::ERowMoveDirection::Up,
				CurrentIndex - Target))
			{
				Error = TEXT("Unreal rejected row reorder");
				return false;
			}
		}
		return true;
	}
	Error = FString::Printf(TEXT("unsupported command kind %s"), *Kind);
	return false;
}

void RestoreTable(UDataTable* Table, const UDataTable* Backup)
{
	Table->EmptyTable();
	for (const FName RowName : Backup->GetRowNames())
	{
		const uint8* const* RowData = Backup->GetRowMap().Find(RowName);
		if (RowData) Table->AddRow(RowName, *RowData, Backup->GetRowStruct());
	}
	Table->HandleDataTableChanged();
}

FString ErrorJson(const FString& Code, const FString& Message)
{
	const TSharedRef<FJsonObject> Error = MakeShared<FJsonObject>();
	Error->SetStringField(TEXT("status"), TEXT("error"));
	Error->SetStringField(TEXT("code"), Code);
	Error->SetStringField(TEXT("message"), Message);
	return JsonString(Error);
}
}

void UUEShedAuthoringLibrary::ListTableObjectPaths(FString& ResultJson)
{
	TArray<FAssetData> Assets;
	FARFilter Filter;
	Filter.PackagePaths.Add(TEXT("/Game"));
	Filter.ClassPaths.Add(UDataTable::StaticClass()->GetClassPathName());
	Filter.bRecursiveClasses = true;
	Filter.bRecursivePaths = true;
	IAssetRegistry::GetChecked().GetAssets(Filter, Assets);
	TArray<FString> ObjectPaths;
	ObjectPaths.Reserve(Assets.Num());
	for (const FAssetData& Asset : Assets)
	{
		ObjectPaths.Add(Asset.GetSoftObjectPath().ToString());
	}
	ObjectPaths.Sort();

	const TSharedRef<FJsonObject> Contract = MakeShared<FJsonObject>();
	Contract->SetStringField(TEXT("name"), TEXT("unreal-authoring-table-list"));
	const TSharedRef<FJsonObject> Version = MakeShared<FJsonObject>();
	Version->SetNumberField(TEXT("major"), 1);
	Version->SetNumberField(TEXT("minor"), 0);
	Contract->SetObjectField(TEXT("version"), Version);
	TArray<TSharedPtr<FJsonValue>> Paths;
	for (const FString& ObjectPath : ObjectPaths)
	{
		Paths.Add(MakeShared<FJsonValueString>(ObjectPath));
	}
	const TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
	Result->SetObjectField(TEXT("contract"), Contract);
	Result->SetArrayField(TEXT("objectPaths"), Paths);
	ResultJson = JsonString(Result);
}

void UUEShedAuthoringLibrary::GetTableSnapshot(
	const FString& TableObjectPath, FString& ResultJson)
{
	const UDataTable* Table = LoadObject<UDataTable>(nullptr, *TableObjectPath);
	if (!Table || !Table->GetRowStruct())
	{
		ResultJson = ErrorJson(TEXT("table_not_found"), TableObjectPath);
		return;
	}

	ResultJson = JsonString(BuildTableSnapshot(Table));
}

void UUEShedAuthoringLibrary::Apply(const FString& RequestJson, FString& ResultJson)
{
	if (RequestJson.Len() > 1024 * 1024)
	{
		ResultJson = ErrorJson(TEXT("request_too_large"), TEXT("Apply request exceeds one MiB"));
		return;
	}
	TSharedPtr<FJsonObject> Request;
	const TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(RequestJson);
	if (!FJsonSerializer::Deserialize(Reader, Request) || !Request.IsValid())
	{
		ResultJson = ErrorJson(TEXT("invalid_request"), TEXT("Apply request is not valid JSON"));
		return;
	}
	if (!HasContract(Request, TEXT("unreal-authoring-apply")))
	{
		ResultJson = ErrorJson(TEXT("unsupported_contract"), TEXT("Apply contract major 1 is required"));
		return;
	}
	FString OperationId;
	if (!Request->TryGetStringField(TEXT("operationId"), OperationId) || OperationId.IsEmpty())
	{
		ResultJson = ErrorJson(TEXT("invalid_request"), TEXT("operationId is required"));
		return;
	}
	const FString CanonicalRequest = CanonicalJson(MakeShared<FJsonValueObject>(Request.ToSharedRef()));
	const FTCHARToUTF8 RequestBytes(*CanonicalRequest);
	const FString RequestDigest = Sha256Hex(
		reinterpret_cast<const uint8*>(RequestBytes.Get()), RequestBytes.Length());
	if (const FApplyCacheEntry* Cached = ApplyResultCache.Find(OperationId))
	{
		if (Cached->RequestDigest == RequestDigest)
		{
			ResultJson = Cached->Result;
			return;
		}
		const TSharedRef<FJsonObject> Collision = MakeShared<FJsonObject>();
		Collision->SetObjectField(
			TEXT("contract"), OperationContract(TEXT("unreal-authoring-apply")));
		Collision->SetStringField(TEXT("operationId"), OperationId);
		Collision->SetStringField(TEXT("status"), TEXT("rejected"));
		Collision->SetArrayField(TEXT("snapshots"), TArray<TSharedPtr<FJsonValue>>());
		TArray<TSharedPtr<FJsonValue>> CollisionErrors;
		CollisionErrors.Add(OperationError(TEXT("operation_id_collision"),
			TEXT("operationId was already used for a different canonical request"), false));
		Collision->SetArrayField(TEXT("errors"), CollisionErrors);
		ResultJson = JsonString(Collision);
		return;
	}
	const TArray<TSharedPtr<FJsonValue>>* TablePlans;
	const TArray<TSharedPtr<FJsonValue>>* Commands;
	if (!Request->TryGetArrayField(TEXT("tables"), TablePlans)
		|| !Request->TryGetArrayField(TEXT("commands"), Commands)
		|| TablePlans->Num() == 0 || TablePlans->Num() > 16 || Commands->Num() > 1024)
	{
		ResultJson = ErrorJson(TEXT("invalid_request"), TEXT("Apply plan limits are invalid"));
		return;
	}

	TMap<FString, UDataTable*> Tables;
	TArray<TSharedPtr<FJsonValue>> Errors;
	for (const TSharedPtr<FJsonValue>& PlanValue : *TablePlans)
	{
		const TSharedPtr<FJsonObject> Plan = PlanValue->AsObject();
		const FString ObjectPath = Plan->GetStringField(TEXT("objectPath"));
		UDataTable* Table = LoadObject<UDataTable>(nullptr, *ObjectPath);
		if (!Table || !Table->GetRowStruct())
		{
			Errors.Add(OperationError(TEXT("table_not_found"), TEXT("DataTable could not be loaded"),
				true, ObjectPath));
			continue;
		}
		if (Table->IsA<UCompositeDataTable>())
		{
			Errors.Add(OperationError(TEXT("read_only_table"),
				TEXT("CompositeDataTable rows are derived and cannot be mutated directly"),
				false, ObjectPath));
			continue;
		}
		if (Tables.Contains(ObjectPath))
		{
			Errors.Add(OperationError(TEXT("duplicate_table"),
				TEXT("Apply plan names a table more than once"), false, ObjectPath));
			continue;
		}
		const FString Expected = Plan->GetStringField(TEXT("expectedFingerprint"));
		const FString Actual = TableFingerprint(Table);
		if (Expected != Actual)
		{
			Errors.Add(OperationError(TEXT("fingerprint_mismatch"),
				FString::Printf(TEXT("expected %s but live state is %s"), *Expected, *Actual),
				false, ObjectPath));
			continue;
		}
		Tables.Add(ObjectPath, Table);
	}

	auto Finish = [&](const TCHAR* Status, const TArray<TSharedPtr<FJsonValue>>& ResultErrors,
		bool bIncludeSnapshots)
	{
		const TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
		Result->SetObjectField(TEXT("contract"), OperationContract(TEXT("unreal-authoring-apply")));
		Result->SetStringField(TEXT("operationId"), OperationId);
		Result->SetStringField(TEXT("status"), Status);
		Result->SetArrayField(TEXT("errors"), ResultErrors);
		TArray<TSharedPtr<FJsonValue>> Snapshots;
		if (bIncludeSnapshots)
		{
			for (const TSharedPtr<FJsonValue>& PlanValue : *TablePlans)
			{
				const FString ObjectPath = PlanValue->AsObject()->GetStringField(TEXT("objectPath"));
				if (UDataTable* const* Table = Tables.Find(ObjectPath))
				{
					Snapshots.Add(MakeShared<FJsonValueObject>(BuildTableSnapshot(*Table)));
				}
			}
		}
		Result->SetArrayField(TEXT("snapshots"), Snapshots);
		ResultJson = JsonString(Result);
		CacheApplyResult(OperationId, RequestDigest, ResultJson);
	};

	if (Errors.Num() > 0 || Tables.Num() != TablePlans->Num())
	{
		Finish(TEXT("rejected"), Errors, false);
		return;
	}

	TMap<FString, TMap<FString, FName>> RowNames;
	TMap<FString, UDataTable*> Backups;
	for (const TPair<FString, UDataTable*>& Pair : Tables)
	{
		UDataTable* Backup = DuplicateObject<UDataTable>(Pair.Value, GetTransientPackage());
		Backup->AddToRoot();
		Backups.Add(Pair.Key, Backup);
		TMap<FString, FName>& Identities = RowNames.Add(Pair.Key);
		for (const FName Name : Pair.Value->GetRowNames())
		{
			Identities.Add(TEXT("row:") + Name.ToString(), Name);
		}
	}
	FScopedTransaction Transaction(NSLOCTEXT("UEShedAuthoring", "Apply", "Apply authoring draft"));
	for (const TPair<FString, UDataTable*>& Pair : Tables) Pair.Value->Modify();
	for (const TSharedPtr<FJsonValue>& CommandValue : *Commands)
	{
		const TSharedPtr<FJsonObject> Command = CommandValue->AsObject();
		const FString CommandId = Command->GetStringField(TEXT("id"));
		const FString ObjectPath = Command->GetStringField(TEXT("tableObjectPath"));
		UDataTable* const* Table = Tables.Find(ObjectPath);
		FString Error;
		if (!Table || !ApplyCommand(*Table, Command, RowNames.FindChecked(ObjectPath), Error))
		{
			if (!Table) Error = TEXT("command references a table outside the Apply plan");
			Transaction.Cancel();
			for (const TPair<FString, UDataTable*>& Pair : Tables)
			{
				RestoreTable(Pair.Value, Backups.FindChecked(Pair.Key));
			}
			for (const TPair<FString, UDataTable*>& Pair : Backups) Pair.Value->RemoveFromRoot();
			Errors.Add(OperationError(TEXT("command_failed"), Error, false, ObjectPath, CommandId));
			Finish(TEXT("rolled_back"), Errors, true);
			return;
		}
	}
	for (const TPair<FString, UDataTable*>& Pair : Backups) Pair.Value->RemoveFromRoot();
	Finish(TEXT("committed"), Errors, true);
}

void UUEShedAuthoringLibrary::LookupApplyResult(
	const FString& OperationId, FString& ResultJson)
{
	if (const FApplyCacheEntry* Entry = ApplyResultCache.Find(OperationId))
	{
		ResultJson = Entry->Result;
		return;
	}
	ResultJson = ErrorJson(TEXT("operation_not_found"), OperationId);
}

void UUEShedAuthoringLibrary::Save(const FString& RequestJson, FString& ResultJson)
{
	TSharedPtr<FJsonObject> Request;
	const TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(RequestJson);
	if (!FJsonSerializer::Deserialize(Reader, Request) || !Request.IsValid())
	{
		ResultJson = ErrorJson(TEXT("invalid_request"), TEXT("Save request is not valid JSON"));
		return;
	}
	if (!HasContract(Request, TEXT("unreal-authoring-save")))
	{
		ResultJson = ErrorJson(TEXT("unsupported_contract"), TEXT("Save contract major 1 is required"));
		return;
	}
	const FString RequestId = Request->GetStringField(TEXT("requestId"));
	const TArray<TSharedPtr<FJsonValue>>* ObjectPaths;
	if (RequestId.IsEmpty() || !Request->TryGetArrayField(TEXT("objectPaths"), ObjectPaths)
		|| ObjectPaths->Num() == 0 || ObjectPaths->Num() > 64)
	{
		ResultJson = ErrorJson(TEXT("invalid_request"), TEXT("Save request limits are invalid"));
		return;
	}
	TArray<TSharedPtr<FJsonValue>> Packages;
	int32 SavedCount = 0;
	for (const TSharedPtr<FJsonValue>& PathValue : *ObjectPaths)
	{
		const FString ObjectPath = PathValue->AsString();
		const TSharedRef<FJsonObject> PackageResult = MakeShared<FJsonObject>();
		PackageResult->SetStringField(TEXT("objectPath"), ObjectPath);
		PackageResult->SetBoolField(TEXT("retrySafe"), true);
		UDataTable* Table = LoadObject<UDataTable>(nullptr, *ObjectPath);
		if (!Table)
		{
			PackageResult->SetStringField(TEXT("packageName"), FString());
			PackageResult->SetStringField(TEXT("status"), TEXT("failed"));
			PackageResult->SetStringField(TEXT("message"), TEXT("DataTable could not be loaded"));
			Packages.Add(MakeShared<FJsonValueObject>(PackageResult));
			continue;
		}
		UPackage* Package = Table->GetOutermost();
		const FString PackageName = Package->GetName();
		PackageResult->SetStringField(TEXT("packageName"), PackageName);
		const FString Filename = FPackageName::LongPackageNameToFilename(
			PackageName, FPackageName::GetAssetPackageExtension());
		FSavePackageArgs SaveArgs;
		SaveArgs.TopLevelFlags = RF_Public | RF_Standalone;
		SaveArgs.SaveFlags = SAVE_NoError;
		if (UPackage::SavePackage(Package, Table, *Filename, SaveArgs))
		{
			PackageResult->SetStringField(TEXT("status"), TEXT("saved"));
			SavedCount++;
		}
		else
		{
			PackageResult->SetStringField(TEXT("status"), TEXT("failed"));
			PackageResult->SetStringField(TEXT("message"), TEXT("Unreal failed to save the package"));
		}
		Packages.Add(MakeShared<FJsonValueObject>(PackageResult));
	}
	const TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
	Result->SetObjectField(TEXT("contract"), OperationContract(TEXT("unreal-authoring-save")));
	Result->SetStringField(TEXT("requestId"), RequestId);
	Result->SetStringField(TEXT("status"), SavedCount == Packages.Num()
		? TEXT("complete") : SavedCount == 0 ? TEXT("failed") : TEXT("partial"));
	Result->SetArrayField(TEXT("packages"), Packages);
	ResultJson = JsonString(Result);
}
