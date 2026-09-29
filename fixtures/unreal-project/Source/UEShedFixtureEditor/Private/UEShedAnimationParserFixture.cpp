#include "UEShedAnimationParserFixture.h"
#include "Animation/AnimSequence.h"
#include "Animation/AnimData/IAnimationDataController.h"
#include "Animation/AnimData/IAnimationDataModel.h"
#include "Animation/Skeleton.h"
#include "AssetRegistry/AssetRegistryModule.h"
#include "Dom/JsonObject.h"
#include "Misc/PackageName.h"
#include "UObject/Package.h"
#include "UObject/SavePackage.h"

namespace { constexpr const TCHAR* PackageName = TEXT("/Game/Fixture/ParserNative/A_Native"); }

bool GenerateAnimationParserFixture(USkeleton* Skeleton)
{
	UPackage* Package = CreatePackage(PackageName);
	Package->FullyLoad();
	UAnimSequence* Sequence = FindObject<UAnimSequence>(Package, TEXT("A_Native"));
	if (!Sequence)
	{
		Sequence = NewObject<UAnimSequence>(Package, TEXT("A_Native"), RF_Public | RF_Standalone);
		FAssetRegistryModule::AssetCreated(Sequence);
	}
	Sequence->SetSkeleton(Skeleton);
	Sequence->RateScale = 1.5f;
	Sequence->bLoop = true;
	Sequence->bEnableRootMotion = true;
	Sequence->bForceRootLock = true;
	Sequence->bUseNormalizedRootMotionScale = false;
	Sequence->RootMotionRootLock = ERootMotionRootLock::AnimFirstFrame;
	IAnimationDataController& Controller = Sequence->GetController();
	Controller.InitializeModel();
	Controller.OpenBracket(FText::FromString(TEXT("Animation parser fixture")), false);
	Controller.ResetModel(false);
	Controller.SetFrameRate(FFrameRate(60, 2), false);
	Controller.SetNumberOfFrames(FFrameNumber(48), false);
	Controller.AddBoneCurve(TEXT("root"), false);
	Controller.SetBoneTrackKeys(TEXT("root"), {FVector3f(1.f, 2.f, 3.f), FVector3f(4.f, 5.f, 6.f)},
		{FQuat4f::Identity, FQuat4f::Identity}, {FVector3f::OneVector, FVector3f::OneVector}, false);
	Controller.AddBoneCurve(TEXT("joint"), false);
	Controller.SetBoneTrackKeys(TEXT("joint"), {FVector3f(0.f, 0.f, 10.f), FVector3f(0.f, 0.f, 20.f)},
		{FQuat4f::Identity, FQuat4f::Identity}, {FVector3f::OneVector, FVector3f::OneVector}, false);
	const FAnimationCurveIdentifier Curve(TEXT("Intensity"), ERawCurveTrackTypes::RCT_Float);
	Controller.AddCurve(Curve, AACF_DefaultCurve, false);
	Controller.SetCurveKeys(Curve, {FRichCurveKey(0.f, 0.25f), FRichCurveKey(1.f, 0.75f), FRichCurveKey(2.f, -0.5f)}, false);
	Controller.NotifyPopulated();
	Controller.CloseBracket(false);
	Sequence->Notifies.Reset();
	FAnimNotifyEvent& Notify = Sequence->Notifies.AddDefaulted_GetRef();
	Notify.NotifyName = TEXT("Footstep");
	Notify.Link(Sequence, 0.5f);
	Notify.TrackIndex = 0;
	Package->MarkPackageDirty();
	FSavePackageArgs Args;
	Args.TopLevelFlags = RF_Public | RF_Standalone;
	Args.SaveFlags = SAVE_NoError;
	return UPackage::SavePackage(Package, Sequence, *FPackageName::LongPackageNameToFilename(PackageName, FPackageName::GetAssetPackageExtension()), Args);
}

TSharedPtr<FJsonObject> AnimationParserFixtureEvidence()
{
	const UAnimSequence* Sequence = LoadObject<UAnimSequence>(nullptr, TEXT("/Game/Fixture/ParserNative/A_Native.A_Native"));
	if (!Sequence || !Sequence->GetDataModel()) return nullptr;
	const IAnimationDataModel* Model = Sequence->GetDataModel();
	auto Result = MakeShared<FJsonObject>();
	Result->SetStringField(TEXT("skeleton"), Sequence->GetSkeleton()->GetPathName());
	Result->SetNumberField(TEXT("duration"), Sequence->GetPlayLength());
	Result->SetNumberField(TEXT("rate_scale"), Sequence->RateScale);
	Result->SetBoolField(TEXT("loop"), Sequence->bLoop);
	Result->SetNumberField(TEXT("frames"), Model->GetNumberOfFrames());
	Result->SetNumberField(TEXT("numerator"), Model->GetFrameRate().Numerator);
	Result->SetNumberField(TEXT("denominator"), Model->GetFrameRate().Denominator);
	Result->SetBoolField(TEXT("root_motion"), Sequence->bEnableRootMotion);
	Result->SetBoolField(TEXT("force_root_lock"), Sequence->bForceRootLock);
	Result->SetBoolField(TEXT("normalized_root_motion"), Sequence->bUseNormalizedRootMotionScale);
	TArray<FName> TrackNames;
	Model->GetBoneTrackNames(TrackNames);
	TArray<TSharedPtr<FJsonValue>> Tracks, Curves, Notifies;
	for (const FName Name : TrackNames) Tracks.Add(MakeShared<FJsonValueString>(Name.ToString()));
	for (const FFloatCurve& Curve : Model->GetFloatCurves())
	{
		auto Entry = MakeShared<FJsonObject>();
		Entry->SetStringField(TEXT("name"), Curve.GetName().ToString());
		Entry->SetNumberField(TEXT("keys"), Curve.FloatCurve.GetNumKeys());
		Curves.Add(MakeShared<FJsonValueObject>(Entry));
	}
	for (const FAnimNotifyEvent& Notify : Sequence->Notifies)
	{
		auto Entry = MakeShared<FJsonObject>();
		Entry->SetStringField(TEXT("name"), Notify.NotifyName.ToString());
		Entry->SetNumberField(TEXT("time"), Notify.GetTime());
		Entry->SetNumberField(TEXT("duration"), Notify.GetDuration());
		Entry->SetNumberField(TEXT("track"), Notify.TrackIndex);
		Notifies.Add(MakeShared<FJsonValueObject>(Entry));
	}
	Result->SetArrayField(TEXT("tracks"), Tracks);
	Result->SetArrayField(TEXT("curves"), Curves);
	Result->SetArrayField(TEXT("notifies"), Notifies);
	return Result;
}
